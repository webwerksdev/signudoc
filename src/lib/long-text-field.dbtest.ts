import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import type { EmailService } from "./services/email.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import type { StorageService } from "./services/storage.ts";
import {
  checkSigningFieldFit,
  recordSignerConsent,
  SigningMutationError,
  submitSigningForToken,
} from "./signing.ts";

// A long answer in a Text field against a real Postgres (issue #90): one
// too long to read in its box on the finished document is refused before
// anything is saved, and one that fits after wrapping is taken.
// Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  // The next signer's invitation reads the install's name through the shared pool.
  globalThis.__signudocPgPool = database;
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

const refuse = async (): Promise<never> => {
  throw new Error("not used");
};

// A typed signature from the first of two signers stores no file and does
// not finish the envelope, so nothing here touches storage.
const storageService: StorageService = {
  deleteObject: refuse,
  getObject: refuse,
  getObjectStream: refuse,
  headObject: refuse,
  putObject: refuse,
};

const emailService: EmailService = {
  async send(message) {
    return { accepted: [message.to], messageId: "m-1", rejected: [] };
  },
  async sendBatch() {
    throw new Error("not used");
  },
};

test("an answer too long for its box is refused, one that wraps to fit is taken", async () => {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const rileyId = randomUUID();
  const caseyId = randomUUID();
  const signatureId = randomUUID();
  const textId = randomUUID();
  const now = unixNow();
  const link = await issueSigningLink({ expiresInSeconds: 60, issuedAt: now });

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
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
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at
      ) values ($1, $2, 'Riley Recipient', $3, 1, 'notified', $4, $5, $6)
    `,
    [
      rileyId,
      envelopeId,
      `${rileyId}@example.test`,
      link.tokenHash,
      link.exp,
      now,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Casey Second', $3, 2, 'pending')
    `,
    [caseyId, envelopeId, `${caseyId}@example.test`],
  );
  // The Text field's place and size from the issue.
  await database.query(
    `
      insert into fields (
        id, envelope_id, signer_id, type, page, x, y, width, height
      ) values
        ($1, $3, $4, 'signature', 1, 0.1, 0.1, 0.2, 0.1),
        ($2, $3, $4, 'text', 1, 0.69, 0.32, 0.19, 0.06)
    `,
    [signatureId, textId, envelopeId, rileyId],
  );
  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  const sign = (answer: string) =>
    submitSigningForToken(
      link.token,
      {
        clientTimezoneOffsetMinutes: 0,
        fields: [
          {
            fieldId: signatureId,
            inputMethod: "typed",
            type: "signature",
            value: "Riley Recipient",
          },
          { fieldId: textId, type: "text", value: answer },
        ],
      },
      { database, emailService, storageService },
    );
  const readState = async () => {
    const field = await database.query<{ value: string | null }>(
      `select value from fields where id = $1`,
      [textId],
    );
    const signer = await database.query<{ status: string }>(
      `select status from signers where id = $1`,
      [rileyId],
    );

    return { status: signer.rows[0]?.status, value: field.rows[0]?.value };
  };

  // As the signer types: the same answer, checked before they finish.
  const tooLongNow = await checkSigningFieldFit(
    link.token,
    { fieldId: textId, value: `BEGIN ${"W".repeat(240)} FINISH-MARKER` },
    { database },
  );

  assert.equal(tooLongNow.fits, false);
  assert.ok(!tooLongNow.fits && tooLongNow.maxCharacters > 0);
  assert.deepEqual(
    await checkSigningFieldFit(
      link.token,
      { fieldId: textId, value: "Approved" },
      { database },
    ),
    { fits: true },
  );
  await assert.rejects(
    checkSigningFieldFit(
      link.token,
      { fieldId: signatureId, value: "Riley Recipient" },
      { database },
    ),
    (error: unknown) =>
      error instanceof SigningMutationError && error.statusCode === 404,
  );

  await assert.rejects(
    sign(`BEGIN ${"W".repeat(240)} FINISH-MARKER`),
    (error: unknown) =>
      error instanceof SigningMutationError &&
      error.statusCode === 400 &&
      /page 1 is too long to fit in its box/.test(error.message) &&
      /Shorten it to \d+ characters or fewer/.test(error.message),
  );
  assert.deepEqual(await readState(), { status: "notified", value: null });

  const answer =
    "BEGIN The tenant agrees to keep the garden tidy, to water the plants twice a week in summer, and to tell the landlord about any leak within two days of finding it. FINISH-MARKER";

  await sign(answer);
  assert.deepEqual(await readState(), { status: "signed", value: answer });
});

test("a dropdown choice wider than its box is taken, since the signer cannot shorten it", async () => {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const rileyId = randomUUID();
  const caseyId = randomUUID();
  const signatureId = randomUUID();
  const dropdownId = randomUUID();
  const now = unixNow();
  const link = await issueSigningLink({ expiresInSeconds: 60, issuedAt: now });
  const choices = [
    "Approved with the conditions listed in the schedule",
    "Rejected until the landlord answers the open questions",
  ];

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
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
      insert into envelope_pages (id, envelope_id, page_number, width_pt, height_pt)
      values ($1, $2, 1, 612, 792)
    `,
    [randomUUID(), envelopeId],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at
      ) values ($1, $2, 'Riley Recipient', $3, 1, 'notified', $4, $5, $6)
    `,
    [
      rileyId,
      envelopeId,
      `${rileyId}@example.test`,
      link.tokenHash,
      link.exp,
      now,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, status)
      values ($1, $2, 'Casey Second', $3, 2, 'pending')
    `,
    [caseyId, envelopeId, `${caseyId}@example.test`],
  );
  // A required dropdown in a box too small for any of its choices.
  await database.query(
    `
      insert into fields (
        id, envelope_id, signer_id, type, page, x, y, width, height, options
      ) values
        ($1, $3, $4, 'signature', 1, 0.1, 0.1, 0.2, 0.1, null),
        ($2, $3, $4, 'dropdown', 1, 0.6, 0.3, 0.05, 0.012, $5)
    `,
    [signatureId, dropdownId, envelopeId, rileyId, JSON.stringify(choices)],
  );
  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  for (const choice of choices) {
    const fit = await checkSigningFieldFit(
      link.token,
      { fieldId: dropdownId, value: choice },
      { database },
    );

    assert.equal(fit.fits, false);
  }

  await submitSigningForToken(
    link.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: signatureId,
          inputMethod: "typed",
          type: "signature",
          value: "Riley Recipient",
        },
        { fieldId: dropdownId, type: "dropdown", value: choices[0] },
      ],
    },
    { database, emailService, storageService },
  );

  const field = await database.query<{ value: string | null }>(
    `select value from fields where id = $1`,
    [dropdownId],
  );
  const signer = await database.query<{ status: string }>(
    `select status from signers where id = $1`,
    [rileyId],
  );

  assert.equal(field.rows[0]?.value, choices[0]);
  assert.equal(signer.rows[0]?.status, "signed");
});
