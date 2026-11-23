import assert from "node:assert/strict";
import { test } from "node:test";

import type { DbExecutor } from "./db/connection.ts";
import { standardDisclosureTemplate } from "./electronic-records-disclosure.ts";
import {
  CONSENT_DISCLOSURE_NOTICE_REQUIRED,
  diffSettings,
  OrganizationSettingsError,
  updateOrganizationSettings,
} from "./organization-settings.ts";
import { resolveSettings, type AppSettings } from "./settings.ts";

const stored: AppSettings = {
  allowedEmailDomains: ["acme.com"],
  brandColor: null,
  consentDisclosure: null,
  emailReadyAt: null,
  logoVersion: null,
  organizationName: "Acme Corp",
  part11Mode: false,
  requireTwoFactor: false,
  sessionIdleMinutes: null,
  sessionMaxHours: null,
  privacyUrl: null,
  retentionDays: null,
  senderAddress: "sign@acme.com",
  setupCompletedAt: 1_800_000_000,
  signupMode: "domains",
  supportAddress: "help@acme.com",
  termsUrl: null,
};

const storedRow = {
  allowed_email_domains: stored.allowedEmailDomains,
  brand_color: stored.brandColor,
  consent_disclosure: stored.consentDisclosure,
  email_ready_at: stored.emailReadyAt,
  logo_hash: stored.logoVersion,
  organization_name: stored.organizationName,
  privacy_url: stored.privacyUrl,
  retention_days: stored.retentionDays,
  sender_address: stored.senderAddress,
  setup_completed_at: stored.setupCompletedAt,
  signup_mode: stored.signupMode,
  support_address: stored.supportAddress,
  terms_url: stored.termsUrl,
};

/**
 * Stands in for the database: answers the read with the stored row and
 * keeps what the save was asked to write.
 */
function fakeDatabase(row = storedRow) {
  const saved: { values: unknown[] | null } = { values: null };
  const database = {
    query: (text: string, values: unknown[] = []) => {
      if (text.includes("insert into public.app_settings")) {
        saved.values = values;

        return Promise.resolve({ rowCount: 0, rows: [] });
      }

      return Promise.resolve({ rowCount: 1, rows: [row] });
    },
  } as unknown as DbExecutor;

  return { database, saved };
}

// What the form sends: every field, as it is shown.
const form = {
  allowedEmailDomains: "acme.com",
  organizationName: "Acme Corp",
  privacyUrl: "",
  senderAddress: "sign@acme.com",
  signupMode: "domains",
  supportAddress: "help@acme.com",
  termsUrl: "",
};

test("a sender fixed by the environment, display name and all, does not block saving the rest", async () => {
  const env = { RESEND_FROM_EMAIL: "Acme Signing <sign@acme.com>" };
  const current = resolveSettings(stored, env);
  const { database, saved } = fakeDatabase();
  const result = await updateOrganizationSettings(
    {
      ...form,
      organizationName: "Acme Corporation",
      // The locked field comes back exactly as it was displayed.
      senderAddress: "Acme Signing <sign@acme.com>",
    },
    current,
    database,
  );

  assert.equal(result.organizationName, "Acme Corporation");
  // The stored sender is left as it was: the one in use is the environment's.
  assert.equal(result.senderAddress, "sign@acme.com");
  assert.ok(saved.values);
});

test("a support address fixed by the environment is not judged or changed either", async () => {
  const current = resolveSettings(stored, { SUPPORT_EMAIL: "desk@acme.com" });
  const { database } = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, supportAddress: "not an address" },
    current,
    database,
  );

  assert.equal(result.supportAddress, "help@acme.com");
});

test("the support address can be changed, but not taken away", async () => {
  const current = resolveSettings(stored, {});

  for (const supportAddress of ["", "   ", null, undefined, "not an address"]) {
    const { database, saved } = fakeDatabase();

    await assert.rejects(
      updateOrganizationSettings(
        { ...form, supportAddress },
        current,
        database,
      ),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationSettingsError);
        assert.deepEqual(error.fieldErrors, {
          supportAddress: "Enter an email address people can write to for help",
        });

        return true;
      },
    );
    assert.equal(saved.values, null);
  }

  const { database } = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, supportAddress: "Desk@Acme.com" },
    current,
    database,
  );

  assert.equal(result.supportAddress, "desk@acme.com");
});

test("an install whose support address comes from SUPPORT_EMAIL needs none of its own", async () => {
  const current = resolveSettings(
    { ...stored, supportAddress: null },
    { SUPPORT_EMAIL: "desk@acme.com" },
  );
  const { database, saved } = fakeDatabase({
    ...storedRow,
    support_address: null,
  });
  const result = await updateOrganizationSettings(
    { ...form, organizationName: "Acme Corporation", supportAddress: "" },
    current,
    database,
  );

  assert.equal(result.organizationName, "Acme Corporation");
  assert.equal(result.supportAddress, null);
  assert.ok(saved.values);
});

test("an address the administrator can edit is still checked", async () => {
  const current = resolveSettings(stored, {});
  const { database, saved } = fakeDatabase();

  await assert.rejects(
    updateOrganizationSettings(
      { ...form, senderAddress: "Acme Signing <sign@acme.com>" },
      current,
      database,
    ),
    (error: unknown) => {
      assert.ok(error instanceof OrganizationSettingsError);
      assert.deepEqual(Object.keys(error.fieldErrors), ["senderAddress"]);

      return true;
    },
  );
  assert.equal(saved.values, null);
});

test("what is left in the hidden domain field does not block closing or opening sign-up", async () => {
  const current = resolveSettings(stored, {});

  for (const signupMode of ["closed", "open"]) {
    const { database } = fakeDatabase();
    const result = await updateOrganizationSettings(
      { ...form, allowedEmailDomains: "not a domain, ???", signupMode },
      current,
      database,
    );

    assert.equal(result.signupMode, signupMode);
    // The list from before is kept for when the rule is switched back.
    assert.deepEqual(result.allowedEmailDomains, ["acme.com"]);
  }
});

test("under the domain rule the list is checked and saved", async () => {
  const current = resolveSettings(stored, {});
  const accepted = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, allowedEmailDomains: "acme.com, Acme.co.uk" },
    current,
    accepted.database,
  );

  assert.deepEqual(result.allowedEmailDomains, ["acme.co.uk", "acme.com"]);

  for (const allowedEmailDomains of ["not a domain", ""]) {
    const refused = fakeDatabase();

    await assert.rejects(
      updateOrganizationSettings(
        { ...form, allowedEmailDomains },
        current,
        refused.database,
      ),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationSettingsError);
        assert.deepEqual(Object.keys(error.fieldErrors), [
          "allowedEmailDomains",
        ]);

        return true;
      },
    );
    assert.equal(refused.saved.values, null);
  }
});

test("the brand color is stored as #rrggbb however it was typed, and empty clears it", async () => {
  const current = resolveSettings(stored, {});

  for (const [typed, expected] of [
    ["1A73E8", "#1a73e8"],
    ["#17e", "#1177ee"],
    [" #0b3d2e ", "#0b3d2e"],
    ["", null],
    [undefined, null],
  ] as const) {
    const { database } = fakeDatabase();
    const result = await updateOrganizationSettings(
      { ...form, brandColor: typed },
      current,
      database,
    );

    assert.equal(result.brandColor, expected, String(typed));
  }
});

test("something that is not a color is refused", async () => {
  const current = resolveSettings(stored, {});

  for (const brandColor of ["red", "#12345", "#fff;}body{display:none}", 7]) {
    const { database, saved } = fakeDatabase();

    await assert.rejects(
      updateOrganizationSettings({ ...form, brandColor }, current, database),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationSettingsError);
        assert.deepEqual(Object.keys(error.fieldErrors), ["brandColor"]);

        return true;
      },
    );
    assert.equal(saved.values, null);
  }
});

test("the hosted service keeps its own color whatever the form sends", async () => {
  const current = resolveSettings(stored, { HOSTED_MODE: "1" });
  const { database } = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, brandColor: "not a color" },
    current,
    database,
  );

  assert.equal(result.brandColor, null);
});

test("a custom disclosure is tidied and saved, and empty puts the built-in one back", async () => {
  const current = resolveSettings(stored, {});
  const saved = fakeDatabase();
  const result = await updateOrganizationSettings(
    {
      ...form,
      consentDisclosure: "  ## Signing online\r\nYou agree to sign online.  ",
      consentDisclosureAcknowledged: true,
    },
    current,
    saved.database,
  );

  assert.equal(
    result.consentDisclosure,
    "## Signing online\nYou agree to sign online.",
  );
  assert.ok(saved.saved.values?.includes(result.consentDisclosure));

  const cleared = await updateOrganizationSettings(
    { ...form, consentDisclosure: "   " },
    resolveSettings({ ...stored, consentDisclosure: "Custom words." }, {}),
    fakeDatabase({ ...storedRow, consent_disclosure: "Custom words." })
      .database,
  );

  assert.equal(cleared.consentDisclosure, null);
});

test("saving words of one's own needs the notice agreed to first", async () => {
  const current = resolveSettings(stored, {});

  await assert.rejects(
    updateOrganizationSettings(
      { ...form, consentDisclosure: "You agree to sign online." },
      current,
      fakeDatabase().database,
    ),
    (error) => {
      assert.ok(error instanceof OrganizationSettingsError);
      assert.deepEqual(error.fieldErrors, {
        consentDisclosure: CONSENT_DISCLOSURE_NOTICE_REQUIRED,
      });
      return true;
    },
  );

  await assert.rejects(
    updateOrganizationSettings(
      {
        ...form,
        consentDisclosure: "You agree to sign online.",
        consentDisclosureAcknowledged: false,
      },
      current,
      fakeDatabase().database,
    ),
    OrganizationSettingsError,
  );
});

test("the same words again, the standard text, or none need no agreement", async () => {
  const withOwn = resolveSettings(
    { ...stored, consentDisclosure: "Custom words." },
    {},
  );
  const again = await updateOrganizationSettings(
    { ...form, consentDisclosure: "  Custom words.\r\n" },
    withOwn,
    fakeDatabase({ ...storedRow, consent_disclosure: "Custom words." })
      .database,
  );

  assert.equal(again.consentDisclosure, "Custom words.");

  // The standard text saved unchanged is the built-in disclosure, so it is
  // stored as none and keeps the dated version.
  const standard = await updateOrganizationSettings(
    { ...form, consentDisclosure: standardDisclosureTemplate() },
    resolveSettings(stored, {}),
    fakeDatabase().database,
  );

  assert.equal(standard.consentDisclosure, null);

  const cleared = await updateOrganizationSettings(
    { ...form, consentDisclosure: "" },
    withOwn,
    fakeDatabase({ ...storedRow, consent_disclosure: "Custom words." })
      .database,
  );

  assert.equal(cleared.consentDisclosure, null);
});

test("a form that does not send the disclosure leaves it as it was", async () => {
  const current = resolveSettings(
    { ...stored, consentDisclosure: "Custom words." },
    {},
  );
  const result = await updateOrganizationSettings(
    { ...form, organizationName: "Acme Corporation" },
    current,
    fakeDatabase({ ...storedRow, consent_disclosure: "Custom words." })
      .database,
  );

  assert.equal(result.organizationName, "Acme Corporation");
  assert.equal(result.consentDisclosure, "Custom words.");
});

test("a disclosure with a heading and no words, or one that is too long, is refused", async () => {
  const current = resolveSettings(stored, {});

  for (const consentDisclosure of ["## Only a heading", "a".repeat(6001)]) {
    const { database, saved } = fakeDatabase();

    await assert.rejects(
      updateOrganizationSettings(
        { ...form, consentDisclosure },
        current,
        database,
      ),
      (error: unknown) => {
        assert.ok(error instanceof OrganizationSettingsError);
        assert.deepEqual(Object.keys(error.fieldErrors), ["consentDisclosure"]);

        return true;
      },
    );
    assert.equal(saved.values, null);
  }
});

test("the hosted service keeps its own disclosure whatever the form sends", async () => {
  const current = resolveSettings(stored, { HOSTED_MODE: "1" });
  const { database } = fakeDatabase();
  const result = await updateOrganizationSettings(
    { ...form, consentDisclosure: "Our own words." },
    current,
    database,
  );

  assert.equal(result.consentDisclosure, null);
});

test("a change to the disclosure is listed in the audit trail", () => {
  const changes = diffSettings(stored, {
    ...stored,
    consentDisclosure: "Custom words.",
  });

  assert.deepEqual(changes, {
    consentDisclosure: { from: null, to: "Custom words." },
  });
});
