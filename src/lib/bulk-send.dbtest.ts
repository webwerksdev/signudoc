import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";
import { ZodError } from "zod";

import {
  BULK_SEND_CLAIM_STALE_SECONDS,
  bulkSendBatchBusyMessage,
  bulkSendBatchMismatchMessage,
  bulkSendFromTemplate,
  bulkSendInvitationUnconfirmedMessage,
  bulkSendSkippedRowMessage,
  BulkSendError,
  missingBulkSendBatchKeyMessage,
} from "./bulk-send.ts";
import { MAX_BULK_SEND_ROWS } from "./bulk-send-csv.ts";
import { openTestDatabase } from "./db/test-database.ts";
import {
  createDraftEnvelope,
  draftRecipientsChangedMessage,
  getEnvelopeDetailDataForUser,
  getPrepareEnvelopeDataForUser,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
} from "./envelopes.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { duplicateCopyRecipientEmailMessage } from "./schemas/signer.ts";
import { eraseSignerData } from "./signer-data.ts";
import { saveEnvelopeAsTemplate, TemplateError } from "./templates.ts";

// Bulk send against a real Postgres: a CSV of people becomes envelopes
// sent from a template, with the template's fields and the chosen
// settings. Run with `npm run test:db`.

const SETTINGS = [
  "APP_URL",
  "DATABASE_URL",
  "EMAIL_CAPTURE_DIR",
  "EMAIL_DRIVER",
  "STORAGE_DRIVER",
  "STORAGE_LOCAL_DIR",
] as const;

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
let sourcePdf: Uint8Array;
let workDir: string;
const createdUsers: string[] = [];
const settingsBefore = new Map<string, string | undefined>();

before(async () => {
  database = await openTestDatabase();
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-bulk-send-"));
  storageDir = path.join(workDir, "storage");
  storageService = createStorageService({
    env: { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: storageDir },
  });

  for (const name of SETTINGS) {
    settingsBefore.set(name, process.env[name]);
  }

  process.env.APP_URL = "http://localhost:3000";
  process.env.DATABASE_URL =
    process.env.E2E_DATABASE_URL ??
    "postgres://signudoc:signudoc@127.0.0.1:5432/signudoc_e2e";
  process.env.EMAIL_CAPTURE_DIR = path.join(workDir, "outbox");
  process.env.EMAIL_DRIVER = "capture";
  process.env.STORAGE_DRIVER = "local";
  process.env.STORAGE_LOCAL_DIR = storageDir;

  const pdf = await PDFDocument.create();

  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  sourcePdf = await pdf.save();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();

  for (const [name, value] of settingsBefore) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  await rm(workDir, { force: true, recursive: true });
});

async function createUser(): Promise<string> {
  const userId = randomUUID();

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );

  return userId;
}

function field(
  signerId: string,
  type: string,
  y: number,
  extra: Record<string, unknown> = {},
) {
  return {
    height: 0.03,
    page: 1,
    required: true,
    signerId,
    type,
    width: 0.2,
    x: 0.1,
    y,
    ...extra,
  };
}

const options = () => ({ database, storageService });

async function createTwoRoleTemplate(
  userId: string,
  { sameStep = false }: { sameStep?: boolean } = {},
) {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: { body: sourcePdf, filename: "lease.pdf" },
      title: "Lease for 12 Harbour Road",
    },
    options(),
  );
  const envelopeId = draft.envelope.id;
  const saved = await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: [
        {
          email: "riley@example.test",
          name: "Riley Recipient",
          ...(sameStep ? { signingStep: 1 } : {}),
        },
        {
          email: "casey@example.test",
          name: "Casey Second",
          ...(sameStep ? { signingStep: 1 } : {}),
        },
      ],
    },
    database,
  );
  const [riley, casey] = saved.signers.map((signer) => signer.id);

  await replaceDraftEnvelopeFields(
    userId,
    envelopeId,
    {
      fields: [
        field(riley!, "signature", 0.1),
        field(casey!, "signature", 0.15, { page: 2 }),
        field(riley!, "text", 0.2, { label: "Unit number", required: false }),
      ],
    },
    database,
  );

  return saveEnvelopeAsTemplate(
    userId,
    envelopeId,
    { name: "Residential lease", roleNames: ["Tenant", "Landlord"] },
    options(),
  );
}

async function createOneRoleTemplate(userId: string) {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: { body: sourcePdf, filename: "nda.pdf" },
      title: "Company NDA",
    },
    options(),
  );
  const saved = await replaceDraftEnvelopeSigners(
    userId,
    draft.envelope.id,
    {
      signers: [{ email: "riley@example.test", name: "Riley Recipient" }],
    },
    database,
  );

  await replaceDraftEnvelopeFields(
    userId,
    draft.envelope.id,
    { fields: [field(saved.signers[0]!.id, "signature", 0.1)] },
    database,
  );

  return saveEnvelopeAsTemplate(
    userId,
    draft.envelope.id,
    { name: "Company NDA", roleNames: ["Signer"] },
    options(),
  );
}

async function countEnvelopes(userId: string): Promise<number> {
  const result = await database.query<{ total: number }>(
    `select count(*)::int as total from envelopes where user_id = $1`,
    [userId],
  );

  return result.rows[0]!.total;
}

async function countSent(userId: string): Promise<number> {
  const result = await database.query<{ total: number }>(
    `select count(*)::int as total from envelopes where user_id = $1 and status = 'sent'`,
    [userId],
  );

  return result.rows[0]!.total;
}

function senderFor(userId: string) {
  return { email: `${userId}@example.test`, name: "Sam Sender" };
}

function confirmBody(
  csv: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    batchKey: randomUUID(),
    confirm: true,
    csv,
    permittedUseConfirmed: true,
    ...extra,
  };
}

function twoRoleCsv(rows: readonly (readonly string[])[]): string {
  return [
    "Tenant name,Tenant email,Landlord name,Landlord email,title",
    ...rows.map((row) => row.join(",")),
  ].join("\n");
}

async function capturedInvitations(): Promise<
  { template: string; to: string[] }[]
> {
  const names = await readdir(process.env.EMAIL_CAPTURE_DIR!).catch(() => []);
  const emails = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        JSON.parse(
          await readFile(
            path.join(process.env.EMAIL_CAPTURE_DIR!, name),
            "utf8",
          ),
        ),
      ),
  );

  return emails.filter((email) => email.template === "signing_invitation");
}

test("a 3-row batch creates and sends three envelopes with the template's fields and settings", async () => {
  const userId = await createUser();
  const template = await createTwoRoleTemplate(userId);
  const before = await countEnvelopes(userId);
  const copyEmail = `zofia-${randomUUID()}@example.test`;
  const people = [
    [
      "Tess One",
      `tess1-${randomUUID()}@example.test`,
      "Lou One",
      `lou1-${randomUUID()}@example.test`,
      "Lease 1",
    ],
    [
      "Tess Two",
      `tess2-${randomUUID()}@example.test`,
      "Lou Two",
      `lou2-${randomUUID()}@example.test`,
      "Lease 2",
    ],
    [
      "Tess Three",
      `tess3-${randomUUID()}@example.test`,
      "Lou Three",
      `lou3-${randomUUID()}@example.test`,
      "Lease 3",
    ],
  ] as const;
  const result = await bulkSendFromTemplate(
    userId,
    template.id,
    {
      ...confirmBody(twoRoleCsv(people), {
        copyRecipients: [{ email: copyEmail, name: "Zofia Copy" }],
        expiresInDays: 14,
        reminderIntervalDays: 3,
        requireEmailCode: true,
      }),
    },
    { ...options(), sender: senderFor(userId) },
  );

  assert.equal(result.summary.sent, 3);
  assert.equal(result.summary.skipped, 0);
  assert.equal(result.summary.failed, 0);
  assert.equal(await countEnvelopes(userId), before + 3);
  assert.equal(await countSent(userId), 3);

  for (const [index, row] of result.rows.entries()) {
    assert.equal(row.status, "sent");
    assert.ok(row.envelopeId);
    assert.equal(row.envelopePath, `/envelopes/${row.envelopeId}`);

    const envelope = await database.query<{
      expires_at: number;
      reminder_interval_days: number | null;
      sent_at: number;
      status: string;
      title: string;
    }>(
      `
        select status, title, sent_at, expires_at, reminder_interval_days
        from envelopes where id = $1
      `,
      [row.envelopeId],
    );
    const stored = envelope.rows[0]!;

    assert.equal(stored.status, "sent");
    assert.equal(stored.title, people[index]![4]);
    assert.equal(stored.reminder_interval_days, 3);
    assert.equal(stored.expires_at - stored.sent_at, 14 * 24 * 60 * 60);

    const prepared = await getPrepareEnvelopeDataForUser(
      userId,
      row.envelopeId!,
      { database },
    );

    assert.ok(prepared);
    assert.deepEqual(
      prepared.signers.map((signer) => [signer.name, signer.email]),
      [
        [people[index]![0], people[index]![1]],
        [people[index]![2], people[index]![3]],
      ],
    );

    const [tenant] = prepared.signers;
    const summary = prepared.fields
      .map((placed) => ({
        label: placed.label,
        page: placed.page,
        signer: placed.signerId === tenant?.id ? "tenant" : "landlord",
        type: placed.type,
      }))
      .sort((left, right) =>
        `${left.type}${left.label ?? ""}`.localeCompare(
          `${right.type}${right.label ?? ""}`,
        ),
      );

    assert.deepEqual(summary, [
      {
        label: undefined,
        page: 1,
        signer: "tenant",
        type: "signature",
      },
      {
        label: undefined,
        page: 2,
        signer: "landlord",
        type: "signature",
      },
      {
        label: "Unit number",
        page: 1,
        signer: "tenant",
        type: "text",
      },
    ]);

    const checks = await database.query<{
      email: string;
      require_email_code: boolean;
      role: string;
    }>(
      `
        select email, require_email_code, role from signers
        where envelope_id = $1 order by sign_order
      `,
      [row.envelopeId],
    );

    assert.deepEqual(
      checks.rows.map((signer) => [
        signer.role,
        signer.require_email_code,
        signer.email,
      ]),
      [
        ["signer", true, people[index]![1]],
        ["signer", true, people[index]![3]],
        ["cc", false, copyEmail],
      ],
    );

    const detail = await getEnvelopeDetailDataForUser(
      userId,
      row.envelopeId!,
      database,
    );

    assert.equal(detail?.copyRecipients[0]?.email, copyEmail);
    assert.equal(
      (
        await database.query(
          `select 1 from audit_events where envelope_id = $1 and event = 'sent'`,
          [row.envelopeId],
        )
      ).rowCount,
      1,
    );
  }

  const invitations = await capturedInvitations();
  const firstSignerEmails = people.map((row) => row[1]);

  assert.equal(
    invitations.filter((email) =>
      firstSignerEmails.some((address) => email.to.includes(address)),
    ).length,
    3,
  );
});

test("copy recipients and email codes keep the template's shared signing step", async () => {
  const userId = await createUser();
  const template = await createTwoRoleTemplate(userId, { sameStep: true });
  const result = await bulkSendFromTemplate(
    userId,
    template.id,
    confirmBody(
      twoRoleCsv([
        [
          "Tess Step",
          `tess-step-${randomUUID()}@example.test`,
          "Lou Step",
          `lou-step-${randomUUID()}@example.test`,
          "Lease",
        ],
      ]),
      {
        copyRecipients: [
          { email: `copy-${randomUUID()}@example.test`, name: "Copy" },
        ],
        requireEmailCode: true,
      },
    ),
    { ...options(), sender: senderFor(userId) },
  );

  assert.equal(result.rows[0]?.status, "sent");
  const steps = await database.query<{ signing_step: number | null }>(
    `select signing_step from signers where envelope_id = $1 and role = 'signer' order by sign_order`,
    [result.rows[0]?.envelopeId],
  );
  assert.deepEqual(
    steps.rows.map((row) => row.signing_step),
    [1, 1],
  );
});

test("a bad row is skipped while the rest send", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const before = await countEnvelopes(userId);
  const goodOne = `ann-${randomUUID()}@example.test`;
  const goodTwo = `cara-${randomUUID()}@example.test`;
  const result = await bulkSendFromTemplate(
    userId,
    template.id,
    {
      ...confirmBody(
        [
          "name,email",
          `Ann,${goodOne}`,
          "Bob,not-an-email",
          `Cara,${goodTwo}`,
        ].join("\n"),
      ),
    },
    { ...options(), sender: senderFor(userId) },
  );

  assert.deepEqual(
    result.rows.map((row) => [row.status, row.reason, Boolean(row.envelopeId)]),
    [
      ["sent", null, true],
      ["skipped", "Enter a valid email address.", false],
      ["sent", null, true],
    ],
  );
  assert.equal(result.summary.sent, 2);
  assert.equal(result.summary.skipped, 1);
  assert.equal(await countEnvelopes(userId), before + 2);
  assert.equal(await countSent(userId), 2);
});

test("the cap is enforced without creating envelopes", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const before = await countEnvelopes(userId);
  const csv = [
    "name,email",
    ...Array.from({ length: MAX_BULK_SEND_ROWS + 1 }, (_, index) => {
      const n = String(index + 1);

      return `Person ${n},person${n}-${userId.slice(0, 8)}@example.test`;
    }),
  ].join("\n");
  const preview = await bulkSendFromTemplate(
    userId,
    template.id,
    { csv },
    options(),
  );

  assert.equal(preview.summary.ok, MAX_BULK_SEND_ROWS);
  assert.equal(preview.summary.skipped, 1);
  assert.equal(preview.rows[MAX_BULK_SEND_ROWS]?.status, "skipped");
  assert.match(preview.rows[MAX_BULK_SEND_ROWS]?.reason ?? "", /200/);
  assert.equal(await countEnvelopes(userId), before);
});

test("another user's template is refused", async () => {
  const owner = await createUser();
  const stranger = await createUser();
  const template = await createOneRoleTemplate(owner);
  const csv = "name,email\nAnn,ann@example.test\n";

  await assert.rejects(
    bulkSendFromTemplate(
      stranger,
      template.id,
      { ...confirmBody(csv) },
      { ...options(), sender: senderFor(stranger) },
    ),
    (error: unknown) =>
      error instanceof TemplateError && error.statusCode === 404,
  );
  assert.equal(await countEnvelopes(stranger), 0);

  const preview = await bulkSendFromTemplate(
    stranger,
    template.id,
    { csv },
    options(),
  ).then(
    () => null,
    (error: unknown) => error,
  );

  assert.ok(preview instanceof TemplateError);
  assert.equal(preview.statusCode, 404);
});

test("Part 11 mode skips a row whose signer has no verified account", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const before = await countEnvelopes(userId);
  const previous = await database.query<{ part11_mode: boolean }>(
    `select part11_mode from app_settings where id`,
  );

  await database.query(
    `
      insert into app_settings (id, signup_mode, created_at, updated_at, part11_mode)
      values (true, 'open', 1, 1, true)
      on conflict (id) do update set part11_mode = true
    `,
  );

  try {
    const result = await bulkSendFromTemplate(
      userId,
      template.id,
      {
        ...confirmBody(`name,email\nAda,ada-${randomUUID()}@example.test\n`, {
          signatureMeaning: "approval",
        }),
      },
      { ...options(), sender: senderFor(userId) },
    );

    assert.equal(result.summary.sent, 0);
    assert.equal(result.summary.skipped, 1);
    assert.match(result.rows[0]?.reason ?? "", /needs an account/);
    assert.equal(await countEnvelopes(userId), before);
  } finally {
    if (previous.rowCount) {
      await database.query(
        `update app_settings set part11_mode = $1 where id`,
        [previous.rows[0]!.part11_mode],
      );
    } else {
      await database.query(`delete from app_settings where id`);
    }
  }
});

test("retrying a confirmed Part 11 batch keeps a skipped row skipped after the signer's account is fixed", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const readyEmail = `ann-${randomUUID()}@example.test`;
  const skippedEmail = `ada-${randomUUID()}@example.test`;
  const readyUserId = randomUUID();

  createdUsers.push(readyUserId);
  await database.query(
    `
      insert into public."user" (
        id, name, email, role, "emailVerified", identity_verified_at, signing_locked_at,
        identity_verified_name, identity_verified_email
      ) values ($1, 'Ann Ready', $2, 'user', true, 1, null, 'Ann Ready', $2)
    `,
    [readyUserId, readyEmail],
  );

  const before = await countEnvelopes(userId);
  const previous = await database.query<{ part11_mode: boolean }>(
    `select part11_mode from app_settings where id`,
  );

  await database.query(
    `
      insert into app_settings (id, signup_mode, created_at, updated_at, part11_mode)
      values (true, 'open', 1, 1, true)
      on conflict (id) do update set part11_mode = true
    `,
  );

  try {
    const body = confirmBody(
      `name,email\nAnn Ready,${readyEmail}\nAda Later,${skippedEmail}\n`,
      { signatureMeaning: "approval" },
    );
    const first = await bulkSendFromTemplate(userId, template.id, body, {
      ...options(),
      sender: senderFor(userId),
    });
    const afterFirst = await countEnvelopes(userId);

    assert.equal(first.summary.sent, 1);
    assert.equal(first.summary.skipped, 1);
    assert.equal(first.summary.failed, 0);
    assert.equal(first.rows[0]?.status, "sent");
    assert.ok(first.rows[0]?.envelopeId);
    assert.equal(first.rows[1]?.status, "skipped");
    assert.equal(first.rows[1]?.envelopeId, null);
    assert.match(first.rows[1]?.reason ?? "", /needs an account/);
    assert.equal(afterFirst, before + 1);

    const storedSkipped = await database.query<{
      envelopeId: string | null;
      reason: string | null;
      status: string;
    }>(
      `
        select r.envelope_id as "envelopeId", r.reason, r.status
        from bulk_send_batches b
        join bulk_send_batch_rows r on r.batch_id = b.id
        where b.user_id = $1 and b.batch_key = $2 and r.row_number = 2
      `,
      [userId, body.batchKey],
    );

    assert.deepEqual(storedSkipped.rows, [
      { envelopeId: null, reason: null, status: "skipped" },
    ]);

    const skippedUserId = randomUUID();

    createdUsers.push(skippedUserId);
    await database.query(
      `
        insert into public."user" (
          id, name, email, role, "emailVerified", identity_verified_at, signing_locked_at,
          identity_verified_name, identity_verified_email
        ) values ($1, 'Ada Later', $2, 'user', true, 1, null, 'Ada Later', $2)
      `,
      [skippedUserId, skippedEmail],
    );

    const retry = await bulkSendFromTemplate(userId, template.id, body, {
      ...options(),
      sender: senderFor(userId),
    });

    assert.equal(retry.summary.sent, 1);
    assert.equal(retry.summary.skipped, 1);
    assert.equal(retry.summary.failed, 0);
    assert.equal(retry.rows[0]?.status, "sent");
    assert.equal(retry.rows[0]?.envelopeId, first.rows[0]?.envelopeId);
    assert.equal(retry.rows[1]?.status, "skipped");
    assert.equal(retry.rows[1]?.reason, bulkSendSkippedRowMessage);
    assert.equal(retry.rows[1]?.envelopeId, null);
    assert.equal(retry.rows[1]?.envelopePath, null);
    assert.equal(await countEnvelopes(userId), afterFirst);
    assert.equal(
      (
        await database.query(
          `select 1 from signers where lower(email) = lower($1)`,
          [skippedEmail],
        )
      ).rowCount,
      0,
    );
  } finally {
    if (previous.rowCount) {
      await database.query(
        `update app_settings set part11_mode = $1 where id`,
        [previous.rows[0]!.part11_mode],
      );
    } else {
      await database.query(`delete from app_settings where id`);
    }
  }
});

test("a Part 11 row goes out only in the confirmed person's name, and is signed in that name", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const accountEmail = `alice-${randomUUID()}@example.test`;
  const accountId = randomUUID();

  createdUsers.push(accountId);
  await database.query(
    `
      insert into public."user" (
        id, name, email, role, "emailVerified", identity_verified_at, signing_locked_at,
        identity_verified_name, identity_verified_email
      ) values ($1, 'Alice Account Holder', $2, 'user', true, 1, null, 'Alice Account Holder', $2)
    `,
    [accountId, accountEmail],
  );

  const previous = await database.query<{ part11_mode: boolean }>(
    `select part11_mode from app_settings where id`,
  );

  await database.query(
    `
      insert into app_settings (id, signup_mode, created_at, updated_at, part11_mode)
      values (true, 'open', 1, 1, true)
      on conflict (id) do update set part11_mode = true
    `,
  );

  try {
    const refused = await bulkSendFromTemplate(
      userId,
      template.id,
      confirmBody(`name,email\nDr Victim Name,${accountEmail}\n`, {
        signatureMeaning: "approval",
      }),
      { ...options(), sender: senderFor(userId) },
    );

    assert.equal(refused.rows[0]?.status, "skipped");
    assert.match(
      refused.rows[0]?.reason ?? "",
      /confirmed as Alice Account Holder/,
    );

    // The same person written another way still goes.
    const result = await bulkSendFromTemplate(
      userId,
      template.id,
      confirmBody(`name,email\nalice holder,${accountEmail.toUpperCase()}\n`, {
        signatureMeaning: "approval",
      }),
      { ...options(), sender: senderFor(userId) },
    );

    assert.equal(result.rows[0]?.status, "sent", result.rows[0]?.reason ?? "");

    const signer = await database.query<{ name: string; userId: string }>(
      `select name, user_id as "userId" from signers where envelope_id = $1`,
      [result.rows[0]?.envelopeId],
    );

    // Named as the administrator confirmed them, not as the CSV had it.
    assert.deepEqual(signer.rows, [
      { name: "Alice Account Holder", userId: accountId },
    ]);

    // The send is recorded in the same name the signer row carries.
    const sent = await database.query<{ signerName: string }>(
      `
        select metadata->>'signerName' as "signerName"
        from audit_events
        where envelope_id = $1 and event = 'sent'
      `,
      [result.rows[0]?.envelopeId],
    );

    assert.deepEqual(sent.rows, [{ signerName: "Alice Account Holder" }]);
  } finally {
    if (previous.rowCount) {
      await database.query(
        `update app_settings set part11_mode = $1 where id`,
        [previous.rows[0]!.part11_mode],
      );
    } else {
      await database.query(`delete from app_settings where id`);
    }
  }
});

test("sending without the permitted-use confirmation is refused, and so is an empty CSV", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);

  await assert.rejects(
    bulkSendFromTemplate(
      userId,
      template.id,
      {
        batchKey: randomUUID(),
        confirm: true,
        csv: "name,email\nAnn,ann@example.test\n",
      },
      { ...options(), sender: senderFor(userId) },
    ),
    (error: unknown) =>
      error instanceof BulkSendError && error.statusCode === 400,
  );
  await assert.rejects(
    bulkSendFromTemplate(userId, template.id, { csv: "" }, options()),
    ZodError,
  );
  await assert.rejects(
    bulkSendFromTemplate(userId, template.id, { csv: "nope" }, options()),
    (error: unknown) =>
      error instanceof BulkSendError && error.statusCode === 400,
  );
  await assert.rejects(
    bulkSendFromTemplate(
      userId,
      template.id,
      {
        confirm: true,
        csv: "name,email\nAnn,ann@example.test\n",
        permittedUseConfirmed: true,
      },
      { ...options(), sender: senderFor(userId) },
    ),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.message === missingBulkSendBatchKeyMessage,
  );
});

async function createUnsignedTemplate(userId: string) {
  const draft = await createDraftEnvelope(
    userId,
    {
      sourcePdf: { body: sourcePdf, filename: "nda.pdf" },
      title: "Unfinished NDA",
    },
    options(),
  );
  const saved = await replaceDraftEnvelopeSigners(
    userId,
    draft.envelope.id,
    {
      signers: [{ email: "riley@example.test", name: "Riley Recipient" }],
    },
    database,
  );

  await replaceDraftEnvelopeFields(
    userId,
    draft.envelope.id,
    {
      fields: [field(saved.signers[0]!.id, "text", 0.1, { label: "Note" })],
    },
    database,
  );

  return saveEnvelopeAsTemplate(
    userId,
    draft.envelope.id,
    { name: "Unfinished NDA", roleNames: ["Signer"] },
    options(),
  );
}

test("a template with no signature field is refused before any row is ready", async () => {
  const userId = await createUser();
  const template = await createUnsignedTemplate(userId);
  const csv = "name,email\nAnn,ann@example.test\n";

  await assert.rejects(
    bulkSendFromTemplate(userId, template.id, { csv }, options()),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.statusCode === 400 &&
      /Signature field/.test(error.message),
  );
  await assert.rejects(
    bulkSendFromTemplate(userId, template.id, confirmBody(csv), {
      ...options(),
      sender: senderFor(userId),
    }),
    (error: unknown) =>
      error instanceof BulkSendError && /Signature field/.test(error.message),
  );
  assert.equal(await countEnvelopes(userId), 1);
});

test("confirming the same batch key does not send the envelopes again", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const batchKey = randomUUID();
  const csv = `name,email\nAnn,ann-${randomUUID()}@example.test\nCara,cara-${randomUUID()}@example.test\n`;
  const body = {
    batchKey,
    confirm: true,
    csv,
    permittedUseConfirmed: true,
  };
  const first = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });
  const afterFirst = await countSent(userId);

  assert.equal(first.summary.sent, 2);
  assert.equal(afterFirst, 2);

  const second = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(second.summary.sent, 2);
  assert.deepEqual(
    second.rows.map((row) => row.envelopeId),
    first.rows.map((row) => row.envelopeId),
  );
  assert.equal(await countSent(userId), afterFirst);
  assert.equal(await countEnvelopes(userId), afterFirst + 1);
});

test("a retry of a batch that already sent a row resumes without a duplicate", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const batchKey = randomUUID();
  const csv = `name,email\nAnn,ann-${randomUUID()}@example.test\n`;
  const body = {
    batchKey,
    confirm: true,
    csv,
    permittedUseConfirmed: true,
  };
  const first = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(first.rows[0]?.status, "sent");
  assert.ok(first.rows[0]?.envelopeId);

  await database.query(
    `
      update bulk_send_batch_rows
      set status = 'processing'
      where envelope_id = $1
    `,
    [first.rows[0].envelopeId],
  );

  const retry = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(retry.rows[0]?.status, "sent");
  assert.equal(retry.rows[0]?.envelopeId, first.rows[0]?.envelopeId);
  assert.equal(
    retry.rows[0]?.signers[0]?.email,
    first.rows[0]?.signers[0]?.email,
  );
  assert.equal(await countSent(userId), 1);
  assert.equal(await countEnvelopes(userId), 2);
});

test("a retry does not report sent until the invitation is recorded", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const batchKey = randomUUID();
  const csv = `name,email\nAnn,ann-${randomUUID()}@example.test\n`;
  const body = {
    batchKey,
    confirm: true,
    csv,
    permittedUseConfirmed: true,
  };
  const first = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(first.rows[0]?.status, "sent");
  assert.ok(first.rows[0]?.envelopeId);

  await database.query(
    `
      update bulk_send_batch_rows
      set status = 'processing', reason = null
      where envelope_id = $1
    `,
    [first.rows[0].envelopeId],
  );
  await database.query(
    `
      delete from audit_events
      where envelope_id = $1 and event = 'email_sent'
    `,
    [first.rows[0].envelopeId],
  );

  const retry = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(retry.rows[0]?.status, "failed");
  assert.equal(retry.rows[0]?.reason, bulkSendInvitationUnconfirmedMessage);
  assert.equal(retry.rows[0]?.envelopeId, first.rows[0]?.envelopeId);
  assert.equal(await countSent(userId), 1);
  assert.equal(await countEnvelopes(userId), 2);
});

test("a stored batch row does not keep signer names or emails", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const email = `ann-${randomUUID()}@example.test`;
  const result = await bulkSendFromTemplate(
    userId,
    template.id,
    confirmBody(`name,email\nAnn Example,${email}\n`),
    { ...options(), sender: senderFor(userId) },
  );

  assert.equal(result.rows[0]?.status, "sent");

  const stored = await database.query(
    `
      select batch_key, request_fingerprint, status, reason
      from bulk_send_batches b
      join bulk_send_batch_rows r on r.batch_id = b.id
      where r.envelope_id = $1
    `,
    [result.rows[0]?.envelopeId],
  );

  assert.equal(stored.rowCount, 1);
  assert.equal(JSON.stringify(stored.rows).includes(email), false);
  assert.equal(JSON.stringify(stored.rows).includes("Ann Example"), false);
});

test("a different list with the same batch key is refused", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const batchKey = randomUUID();
  const firstCsv = `name,email\nAnn,ann-${randomUUID()}@example.test\n`;

  await bulkSendFromTemplate(
    userId,
    template.id,
    {
      batchKey,
      confirm: true,
      csv: firstCsv,
      permittedUseConfirmed: true,
    },
    { ...options(), sender: senderFor(userId) },
  );

  await assert.rejects(
    bulkSendFromTemplate(
      userId,
      template.id,
      {
        batchKey,
        confirm: true,
        csv: `name,email\nCara,cara-${randomUUID()}@example.test\n`,
        permittedUseConfirmed: true,
      },
      { ...options(), sender: senderFor(userId) },
    ),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.message === bulkSendBatchMismatchMessage,
  );
});

test("an unexpected row failure is logged and kept for the sender", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const errors: unknown[] = [];
  const originalError = console.error;
  const failingStorage: StorageService = {
    deleteObject: (key) => storageService.deleteObject(key),
    getObject: async () => {
      throw new Error("disk full");
    },
    getObjectStream: (key) => storageService.getObjectStream(key),
    headObject: (key) => storageService.headObject(key),
    putObject: (input) => storageService.putObject(input),
  };

  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  try {
    const result = await bulkSendFromTemplate(
      userId,
      template.id,
      confirmBody(`name,email\nAnn,ann-${randomUUID()}@example.test\n`),
      {
        database,
        sender: senderFor(userId),
        storageService: failingStorage,
      },
    );

    assert.equal(result.rows[0]?.status, "failed");
    assert.equal(result.rows[0]?.reason, "Unable to send this envelope.");
    assert.equal(
      errors.some((entry) =>
        JSON.stringify(entry).includes("template_bulk_send_row_failure"),
      ),
      true,
    );
    assert.equal(
      errors.some(
        (entry) =>
          Array.isArray(entry) &&
          entry.some(
            (value) => value instanceof Error && value.message === "disk full",
          ),
      ),
      true,
    );
  } finally {
    console.error = originalError;
  }
});

test("a batch another request is sending is refused at once, and a stale claim is taken over", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const body = confirmBody(
    `name,email\nAnn,ann-${randomUUID()}@example.test\n`,
  );
  const first = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(first.rows[0]?.status, "sent");

  const released = await database.query<{ claimToken: string | null }>(
    `select claim_token as "claimToken" from bulk_send_batches where user_id = $1 and batch_key = $2`,
    [userId, body.batchKey],
  );

  assert.equal(released.rows[0]?.claimToken, null);

  await database.query(
    `
      update bulk_send_batches
      set claim_token = 'another-request',
        claimed_at = extract(epoch from now())::bigint
      where user_id = $1 and batch_key = $2
    `,
    [userId, body.batchKey],
  );

  await assert.rejects(
    bulkSendFromTemplate(userId, template.id, body, {
      ...options(),
      sender: senderFor(userId),
    }),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.statusCode === 409 &&
      error.message === bulkSendBatchBusyMessage,
  );

  await database.query(
    `
      update bulk_send_batches
      set claimed_at = extract(epoch from now())::bigint - $3
      where user_id = $1 and batch_key = $2
    `,
    [userId, body.batchKey, BULK_SEND_CLAIM_STALE_SECONDS + 1],
  );

  const retry = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(retry.rows[0]?.status, "sent");
  assert.equal(retry.rows[0]?.envelopeId, first.rows[0]?.envelopeId);
  assert.equal(await countSent(userId), 1);
});

test("two confirms of one batch at once send each row once", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const body = confirmBody(
    `name,email\nAnn,ann-${randomUUID()}@example.test\nCara,cara-${randomUUID()}@example.test\n`,
  );
  const attempts = await Promise.allSettled([
    bulkSendFromTemplate(userId, template.id, body, {
      ...options(),
      sender: senderFor(userId),
    }),
    bulkSendFromTemplate(userId, template.id, body, {
      ...options(),
      sender: senderFor(userId),
    }),
  ]);

  for (const attempt of attempts) {
    if (attempt.status === "rejected") {
      assert.ok(attempt.reason instanceof BulkSendError);
      assert.equal(attempt.reason.message, bulkSendBatchBusyMessage);
    }
  }

  assert.ok(attempts.some((attempt) => attempt.status === "fulfilled"));
  assert.equal(await countSent(userId), 2);
});

test("skipped rows are returned but not saved to the batch", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const body = confirmBody(
    `name,email\nAnn,ann-${randomUUID()}@example.test\nBo,not-an-email\n`,
  );
  const first = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.deepEqual(
    first.rows.map((row) => row.status),
    ["sent", "skipped"],
  );

  const stored = await database.query<{ rowNumber: number; status: string }>(
    `
      select r.row_number as "rowNumber", r.status
      from bulk_send_batches b
      join bulk_send_batch_rows r on r.batch_id = b.id
      where b.user_id = $1 and b.batch_key = $2
    `,
    [userId, body.batchKey],
  );

  assert.deepEqual(stored.rows, [
    { rowNumber: first.rows[0]!.rowNumber, status: "sent" },
  ]);

  const retry = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.deepEqual(
    retry.rows.map((row) => [row.status, row.reason]),
    first.rows.map((row) => [row.status, row.reason]),
  );
  assert.equal(await countSent(userId), 1);
});

test("a repeated copy recipient is refused before the preview", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const before = await countEnvelopes(userId);
  const copyRecipients = [
    { email: "copy@example.test", name: "Copy One" },
    { email: "COPY@example.test", name: "Copy Two" },
  ];
  const csv = `name,email\nAnn,ann-${randomUUID()}@example.test\n`;

  for (const body of [
    { copyRecipients, csv },
    confirmBody(csv, { copyRecipients }),
  ]) {
    await assert.rejects(
      bulkSendFromTemplate(userId, template.id, body, {
        ...options(),
        sender: senderFor(userId),
      }),
      (error: unknown) =>
        error instanceof ZodError &&
        error.issues[0]?.message === duplicateCopyRecipientEmailMessage,
    );
  }

  assert.equal(await countEnvelopes(userId), before);
});

test("erasing a signer clears a saved failure reason that names them", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const email = `ann-${randomUUID()}@example.test`;
  const result = await bulkSendFromTemplate(
    userId,
    template.id,
    confirmBody(`name,email\nAnn Example,${email}\n`),
    { ...options(), sender: senderFor(userId) },
  );
  const envelopeId = result.rows[0]?.envelopeId;

  assert.ok(envelopeId);

  await database.query(
    `
      update bulk_send_batch_rows
      set status = 'failed', reason = $2
      where envelope_id = $1
    `,
    [envelopeId, `Ann Example (${email}) needs an account on this site.`],
  );

  await eraseSignerData(email, email, database);

  const stored = await database.query<{ reason: string | null }>(
    `select reason from bulk_send_batch_rows where envelope_id = $1`,
    [envelopeId],
  );

  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0]?.reason, null);
});

test("deleting a failed row's draft clears its reason and keeps its status", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const email = `ann-${randomUUID()}@example.test`;
  const body = confirmBody(`name,email\nAnn Example,${email}\n`);
  const envelopeId = await leaveProcessingDraft(userId, template.id, body);

  await database.query(
    `
      update bulk_send_batch_rows
      set status = 'failed', reason = $2
      where envelope_id = $1
    `,
    [envelopeId, `Ann Example (${email}) needs an account on this site.`],
  );

  const batch = await database.query<{ id: string }>(
    `select batch_id as id from bulk_send_batch_rows where envelope_id = $1`,
    [envelopeId],
  );
  const batchId = batch.rows[0]!.id;

  // The stale draft cleanup deletes the draft row the same way.
  const deleted = await database.query(
    `delete from envelopes where id = $1 and status = 'draft'`,
    [envelopeId],
  );

  assert.equal(deleted.rowCount, 1);

  const stored = await database.query<{
    envelopeId: string | null;
    reason: string | null;
    status: string;
  }>(
    `
      select envelope_id as "envelopeId", reason, status
      from bulk_send_batch_rows
      where batch_id = $1
    `,
    [batchId],
  );

  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0]?.status, "failed");
  assert.equal(stored.rows[0]?.envelopeId, null);
  assert.equal(stored.rows[0]?.reason, null);
});

async function takeOverBatch(userId: string, batchKey: unknown) {
  await database.query(
    `
      update bulk_send_batches
      set claim_token = 'another-request',
        claimed_at = extract(epoch from now())::bigint
      where user_id = $1 and batch_key = $2
    `,
    [userId, batchKey],
  );
}

test("a request that loses its claim while making a draft saves and sends nothing", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const body = confirmBody(
    `name,email\nAnn,ann-${randomUUID()}@example.test\n`,
  );
  const envelopesBefore = await countEnvelopes(userId);
  // A retry takes the batch over while this request reads the template's
  // file, as it could if the read stalled past the claim's lifetime.
  const slowStorage: StorageService = {
    deleteObject: (key) => storageService.deleteObject(key),
    getObject: async (key) => {
      await takeOverBatch(userId, body.batchKey);
      return storageService.getObject(key);
    },
    getObjectStream: (key) => storageService.getObjectStream(key),
    headObject: (key) => storageService.headObject(key),
    putObject: (input) => storageService.putObject(input),
  };

  await assert.rejects(
    bulkSendFromTemplate(userId, template.id, body, {
      database,
      sender: senderFor(userId),
      storageService: slowStorage,
    }),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.statusCode === 409 &&
      error.message === bulkSendBatchBusyMessage,
  );

  const saved = await database.query(
    `
      select r.row_number
      from bulk_send_batch_rows r
      join bulk_send_batches b on b.id = r.batch_id
      where b.user_id = $1 and b.batch_key = $2
    `,
    [userId, body.batchKey],
  );

  assert.equal(saved.rowCount, 0);
  assert.equal(await countSent(userId), 0);
  assert.equal(await countEnvelopes(userId), envelopesBefore);
});

test("a request that loses its claim before sending does not send, and the retry sends the same envelope", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const body = confirmBody(
    `name,email\nAnn,ann-${randomUUID()}@example.test\n`,
  );
  // A retry takes the batch over right after the row's envelope is saved.
  const slowDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "query") {
        return Reflect.get(target, property, receiver);
      }

      return async (text: string, values?: unknown[]) => {
        const result = await target.query(text, values);

        if (
          typeof text === "string" &&
          text.includes("INSERT INTO bulk_send_batch_rows") &&
          values?.[2] === "processing"
        ) {
          await takeOverBatch(userId, body.batchKey);
        }

        return result;
      };
    },
  });

  await assert.rejects(
    bulkSendFromTemplate(userId, template.id, body, {
      database: slowDatabase,
      sender: senderFor(userId),
      storageService,
    }),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.message === bulkSendBatchBusyMessage,
  );

  const stored = await database.query<{
    envelopeId: string | null;
    status: string;
  }>(
    `
      select r.envelope_id as "envelopeId", r.status
      from bulk_send_batch_rows r
      join bulk_send_batches b on b.id = r.batch_id
      where b.user_id = $1 and b.batch_key = $2
    `,
    [userId, body.batchKey],
  );

  assert.equal(stored.rows[0]?.status, "processing");
  assert.ok(stored.rows[0]?.envelopeId);
  assert.equal(await countSent(userId), 0);

  await database.query(
    `
      update bulk_send_batches
      set claimed_at = extract(epoch from now())::bigint - $3
      where user_id = $1 and batch_key = $2
    `,
    [userId, body.batchKey, BULK_SEND_CLAIM_STALE_SECONDS + 1],
  );

  const retry = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(retry.rows[0]?.status, "sent");
  assert.equal(retry.rows[0]?.envelopeId, stored.rows[0]?.envelopeId);
  assert.equal(await countSent(userId), 1);
  assert.equal(await countEnvelopes(userId), 2);
});

/** Loses the claim right after the row's draft is saved, as a slow request would. */
async function leaveProcessingDraft(
  userId: string,
  templateId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const slowDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "query") {
        return Reflect.get(target, property, receiver);
      }

      return async (text: string, values?: unknown[]) => {
        const result = await target.query(text, values);

        if (
          typeof text === "string" &&
          text.includes("INSERT INTO bulk_send_batch_rows") &&
          values?.[2] === "processing"
        ) {
          await takeOverBatch(userId, body.batchKey);
        }

        return result;
      };
    },
  });

  await assert.rejects(
    bulkSendFromTemplate(userId, templateId, body, {
      database: slowDatabase,
      sender: senderFor(userId),
      storageService,
    }),
    (error: unknown) =>
      error instanceof BulkSendError &&
      error.message === bulkSendBatchBusyMessage,
  );

  const stored = await database.query<{ envelopeId: string }>(
    `
      select r.envelope_id as "envelopeId"
      from bulk_send_batch_rows r
      join bulk_send_batches b on b.id = r.batch_id
      where b.user_id = $1 and b.batch_key = $2 and r.status = 'processing'
    `,
    [userId, body.batchKey],
  );

  await database.query(
    `
      update bulk_send_batches
      set claimed_at = extract(epoch from now())::bigint - $3
      where user_id = $1 and batch_key = $2
    `,
    [userId, body.batchKey, BULK_SEND_CLAIM_STALE_SECONDS + 1],
  );

  return stored.rows[0]!.envelopeId;
}

test("a retry does not send a saved draft whose signer was changed", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const body = confirmBody(
    `name,email\nAnn,ann-${randomUUID()}@example.test\n`,
  );
  const envelopeId = await leaveProcessingDraft(userId, template.id, body);
  const prepared = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
    database,
  });
  const otherEmail = `other-${randomUUID()}@example.test`;

  await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    {
      signers: [
        { email: otherEmail, id: prepared!.signers[0]!.id, name: "Other" },
      ],
    },
    database,
  );

  const retry = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(retry.rows[0]?.status, "failed");
  assert.equal(retry.rows[0]?.reason, draftRecipientsChangedMessage);
  assert.equal(retry.rows[0]?.envelopeId, envelopeId);
  assert.equal(await countSent(userId), 0);
  assert.ok(
    !(await capturedInvitations()).some((email) =>
      email.to.includes(otherEmail),
    ),
  );
});

test("a retry does not send a saved two-role draft that lost a signer", async () => {
  const userId = await createUser();
  const template = await createTwoRoleTemplate(userId);
  const tenantEmail = `tenant-${randomUUID()}@example.test`;
  const body = confirmBody(
    twoRoleCsv([
      [
        "Tia Tenant",
        tenantEmail,
        "Lou Landlord",
        `landlord-${randomUUID()}@example.test`,
        "Lease",
      ],
    ]),
  );
  const envelopeId = await leaveProcessingDraft(userId, template.id, body);
  const prepared = await getPrepareEnvelopeDataForUser(userId, envelopeId, {
    database,
  });
  const tenant = prepared!.signers.find((signer) => signer.order === 1)!;

  await replaceDraftEnvelopeSigners(
    userId,
    envelopeId,
    { signers: [{ email: tenant.email, id: tenant.id, name: tenant.name }] },
    database,
  );

  const retry = await bulkSendFromTemplate(userId, template.id, body, {
    ...options(),
    sender: senderFor(userId),
  });

  assert.equal(retry.rows[0]?.status, "failed");
  assert.equal(retry.rows[0]?.reason, draftRecipientsChangedMessage);
  assert.equal(await countSent(userId), 0);
  assert.ok(
    !(await capturedInvitations()).some((email) =>
      email.to.includes(tenantEmail),
    ),
  );
});

test("a draft changed after the row is checked and before it is sent is not sent", async () => {
  const userId = await createUser();
  const template = await createOneRoleTemplate(userId);
  const body = confirmBody(
    `name,email\nAnn,ann-${randomUUID()}@example.test\n`,
  );
  const otherEmail = `other-${randomUUID()}@example.test`;
  let draftSaved = false;
  let edited = false;
  // The sender edits the draft between the row's last claim refresh and
  // the send, after every check in the batch code has run.
  const editingDatabase = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "query") {
        return Reflect.get(target, property, receiver);
      }

      return async (text: string, values?: unknown[]) => {
        const result = await target.query(text, values);

        if (
          typeof text === "string" &&
          text.includes("INSERT INTO bulk_send_batch_rows") &&
          values?.[2] === "processing"
        ) {
          draftSaved = true;
        } else if (
          draftSaved &&
          !edited &&
          typeof text === "string" &&
          text.includes("SET claimed_at") &&
          !text.includes("INSERT")
        ) {
          edited = true;

          const envelopeId = (
            await target.query<{ envelopeId: string }>(
              `
                select r.envelope_id as "envelopeId"
                from bulk_send_batch_rows r
                join bulk_send_batches b on b.id = r.batch_id
                where b.user_id = $1 and b.batch_key = $2
              `,
              [userId, body.batchKey],
            )
          ).rows[0]!.envelopeId;
          const prepared = await getPrepareEnvelopeDataForUser(
            userId,
            envelopeId,
            { database: target },
          );

          await replaceDraftEnvelopeSigners(
            userId,
            envelopeId,
            {
              signers: [
                {
                  email: otherEmail,
                  id: prepared!.signers[0]!.id,
                  name: "Other",
                },
              ],
            },
            target,
          );
        }

        return result;
      };
    },
  });

  const result = await bulkSendFromTemplate(userId, template.id, body, {
    database: editingDatabase,
    sender: senderFor(userId),
    storageService,
  });

  assert.ok(edited);
  assert.equal(result.rows[0]?.status, "failed");
  assert.equal(result.rows[0]?.reason, draftRecipientsChangedMessage);
  assert.equal(await countSent(userId), 0);
  assert.ok(
    !(await capturedInvitations()).some((email) =>
      email.to.includes(otherEmail),
    ),
  );
});
