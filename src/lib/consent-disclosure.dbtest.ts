import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  ELECTRONIC_RECORDS_DISCLOSURE_VERSION,
  getDisclosureVersion,
} from "./electronic-records-disclosure.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { invalidateSettingsCache } from "./settings.ts";
import {
  getSigningPayloadForToken,
  recordSignerConsent,
  SigningMutationError,
} from "./signing.ts";

// An administrator's own disclosure against a real Postgres: the signing page
// shows it at once, consent is held to its version, and the audit trail keeps
// the words the signer read, filled in. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

let database: pg.Pool;
const createdUsers: string[] = [];
let disclosureBefore: string | null = null;
let hadSettingsRow = false;

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;

  // There is one settings row for the whole database. Whatever other tests
  // left in it is put back afterwards.
  const existing = await database.query<{ consent_disclosure: string | null }>(
    "select consent_disclosure from public.app_settings where id",
  );

  hadSettingsRow = existing.rows.length > 0;
  disclosureBefore = existing.rows[0]?.consent_disclosure ?? null;
});

after(async () => {
  if (hadSettingsRow) {
    await database.query(
      "update public.app_settings set consent_disclosure = $1 where id",
      [disclosureBefore],
    );
  } else {
    await database.query("delete from public.app_settings where id");
  }

  invalidateSettingsCache();
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

async function setDisclosure(text: string | null) {
  const now = Math.floor(Date.now() / 1000);

  await database.query(
    `
      insert into public.app_settings (id, consent_disclosure, created_at, updated_at)
      values (true, $1, $2, $2)
      on conflict (id) do update set consent_disclosure = excluded.consent_disclosure
    `,
    [text, now],
  );
}

async function sentEnvelope() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const link = await issueSigningLink({ expiresInSeconds: 600, issuedAt: now });

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Dollar $$ Consulting', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at
      ) values ($1, $2, 'Lease', 'sent', $3, 'lease.pdf', 10, 1, $4, $5)
    `,
    [envelopeId, userId, `test/${envelopeId}.pdf`, "a".repeat(64), now],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at
      ) values ($1, $2, 'Riley Recipient', $3, 1, 'notified', $4, $5, $6)
    `,
    [
      signerId,
      envelopeId,
      `${signerId}@example.test`,
      link.tokenHash,
      link.exp,
      now,
    ],
  );
  await database.query(
    `
      insert into fields (id, envelope_id, signer_id, type, page, x, y, width, height)
      values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.1)
    `,
    [randomUUID(), envelopeId, signerId],
  );

  return { envelopeId, token: link.token };
}

test("an administrator's own disclosure is shown, agreed to and kept, filled in", async () => {
  const custom = "## Signing with {sender}\nWe send this online.";

  await setDisclosure(custom);

  const { envelopeId, token } = await sentEnvelope();
  const payload = await getSigningPayloadForToken(token, { database });

  const shown = "Signing with Dollar $$ Consulting\nWe send this online.";

  assert.equal(payload.disclosure.version, getDisclosureVersion(shown));
  assert.deepEqual(payload.disclosure.sections, [
    {
      heading: "Signing with Dollar $$ Consulting",
      text: "We send this online.",
    },
  ]);

  await recordSignerConsent(
    token,
    { disclosureVersion: payload.disclosure.version },
    { database },
  );

  const consented = await database.query<{
    metadata: { disclosureText?: string; disclosureVersion?: string };
  }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'consented'`,
    [envelopeId],
  );

  assert.equal(consented.rows.length, 1);
  assert.equal(
    consented.rows[0]?.metadata.disclosureVersion,
    getDisclosureVersion(shown),
  );
  assert.equal(
    consented.rows[0]?.metadata.disclosureText,
    "Signing with Dollar $$ Consulting\nWe send this online.",
  );
});

test("a change to the disclosure shows at once, and the older version is refused", async () => {
  await setDisclosure("First words.");

  const { envelopeId, token } = await sentEnvelope();
  const first = await getSigningPayloadForToken(token, { database });

  // A change made elsewhere. The settings cache in this process still holds
  // the first words, and the signing page must not use it.
  await setDisclosure("Second words.");

  const second = await getSigningPayloadForToken(token, { database });

  assert.notEqual(second.disclosure.version, first.disclosure.version);
  assert.equal(
    second.disclosure.version,
    getDisclosureVersion("Second words."),
  );

  await assert.rejects(
    recordSignerConsent(
      token,
      { disclosureVersion: first.disclosure.version },
      { database },
    ),
    (error) => {
      assert.ok(error instanceof SigningMutationError);
      assert.equal(error.statusCode, 409);
      return true;
    },
  );

  await recordSignerConsent(
    token,
    { disclosureVersion: second.disclosure.version },
    { database },
  );

  const consented = await database.query(
    `select 1 from audit_events where envelope_id = $1 and event = 'consented'`,
    [envelopeId],
  );

  assert.equal(consented.rows.length, 1);
});

test("a change to the support address after the page loaded is refused too", async () => {
  await setDisclosure("Write to {contact}.");

  const { token } = await sentEnvelope();
  const before = await getSigningPayloadForToken(token, { database });
  const supportBefore = await database.query<{
    support_address: string | null;
  }>("select support_address from public.app_settings where id");

  try {
    await database.query(
      "update public.app_settings set support_address = 'new-help@example.test' where id",
    );
    // The settings cache in this process still holds the old address, as
    // another server instance would. The signing page must not use it.

    const afterChange = await getSigningPayloadForToken(token, { database });

    assert.notEqual(afterChange.disclosure.version, before.disclosure.version);
    await assert.rejects(
      recordSignerConsent(
        token,
        { disclosureVersion: before.disclosure.version },
        { database },
      ),
      SigningMutationError,
    );
  } finally {
    await database.query(
      "update public.app_settings set support_address = $1 where id",
      [supportBefore.rows[0]?.support_address ?? null],
    );
    invalidateSettingsCache();
  }
});

test("with no disclosure of its own the built-in one is used and no text is kept", async () => {
  await setDisclosure(null);

  const { envelopeId, token } = await sentEnvelope();
  const payload = await getSigningPayloadForToken(token, { database });

  assert.equal(
    payload.disclosure.version,
    ELECTRONIC_RECORDS_DISCLOSURE_VERSION,
  );

  await recordSignerConsent(
    token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  const consented = await database.query<{
    metadata: { disclosureText?: string };
  }>(
    `select metadata from audit_events where envelope_id = $1 and event = 'consented'`,
    [envelopeId],
  );

  assert.equal(consented.rows[0]?.metadata.disclosureText, undefined);
});
