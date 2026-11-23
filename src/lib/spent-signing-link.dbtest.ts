import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import { ELECTRONIC_RECORDS_DISCLOSURE_VERSION } from "./electronic-records-disclosure.ts";
import { sendDraftEnvelope, voidSentEnvelope } from "./envelopes.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  declineSigningForToken,
  getSigningPayloadForToken,
  recordSignerConsent,
  SigningAccessError,
  submitSigningForToken,
} from "./signing.ts";

// What an invitation says once it can no longer be used, against a real
// Postgres. Signing, declining and voiding all retire the link, and the page
// it opens should say what happened to the envelope rather than ask the
// signer for a new link the sender cannot send. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

// A PNG of one transparent pixel, standing in for a drawn signature.
const DRAWN_SIGNATURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  // The seal and the emails read the install's settings through the shared
  // pool.
  globalThis.__signudocPgPool = database;
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-spent-link-"));
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: path.join(storageDir, "outbox"),
    EMAIL_DRIVER: "capture",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

/**
 * A sent envelope whose first signer holds an open, consented link. With
 * `withSecondSigner`, a second signer waits behind them, so the first
 * signature does not finish the envelope.
 */
async function createSentEnvelope({ withSecondSigner = false } = {}) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const fieldId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const link = await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now });
  const sourcePdf = await PDFDocument.create();

  sourcePdf.addPage([612, 792]);

  const sourcePdfBytes = await sourcePdf.save();
  const sourcePdfKey = `test/${envelopeId}.pdf`;

  await storageService.putObject({
    body: sourcePdfBytes,
    contentType: "application/pdf",
    key: sourcePdfKey,
  });

  createdUsers.push(userId);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Sam Sender', $2, 'user')`,
    [userId, `${userId}@example.test`],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at, expires_at
      ) values ($1, $2, 'Lease', 'sent', $3, 'lease.pdf', $4, 1, $5, $6, $7)
    `,
    [
      envelopeId,
      userId,
      sourcePdfKey,
      sourcePdfBytes.length,
      createHash("sha256").update(sourcePdfBytes).digest("hex"),
      now,
      now + DAY,
    ],
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
      insert into fields (
        id, envelope_id, signer_id, type, page, x, y, width, height
      ) values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.1)
    `,
    [fieldId, envelopeId, signerId],
  );

  if (withSecondSigner) {
    const secondId = randomUUID();

    await database.query(
      `
        insert into signers (id, envelope_id, name, email, sign_order, status)
        values ($1, $2, 'Casey Second', $3, 2, 'pending')
      `,
      [secondId, envelopeId, `${secondId}@example.test`],
    );
    await database.query(
      `
        insert into fields (
          id, envelope_id, signer_id, type, page, x, y, width, height
        ) values ($1, $2, $3, 'signature', 1, 0.1, 0.4, 0.2, 0.1)
      `,
      [randomUUID(), envelopeId, secondId],
    );
  }

  await recordSignerConsent(
    link.token,
    { disclosureVersion: ELECTRONIC_RECORDS_DISCLOSURE_VERSION },
    { database },
  );

  return { envelopeId, fieldId, token: link.token, userId };
}

type Envelope = Awaited<ReturnType<typeof createSentEnvelope>>;

function signEnvelope(envelope: Envelope) {
  return submitSigningForToken(
    envelope.token,
    {
      clientTimezoneOffsetMinutes: 0,
      fields: [
        {
          fieldId: envelope.fieldId,
          imageDataUrl: DRAWN_SIGNATURE,
          inputMethod: "drawn",
          type: "signature",
        },
      ],
    },
    { database },
  );
}

/** The state the signing page shows for a link that opens nothing. */
async function unavailableState(token: string) {
  try {
    await getSigningPayloadForToken(token, { database });
  } catch (error) {
    assert.ok(error instanceof SigningAccessError, String(error));
    return { message: error.message, state: error.state };
  }

  assert.fail("The link still opened the document.");
}

async function envelopeStatus(envelopeId: string) {
  const result = await database.query<{ status: string }>(
    `select status from envelopes where id = $1`,
    [envelopeId],
  );

  return result.rows[0]?.status;
}

test("a link reopened after the envelope is completed says it is complete", async () => {
  const envelope = await createSentEnvelope();

  await signEnvelope(envelope);
  assert.equal(await envelopeStatus(envelope.envelopeId), "completed");

  const reopened = await unavailableState(envelope.token);

  assert.equal(reopened.state, "completed");
  assert.doesNotMatch(reopened.message, /new signing link|expired/i);
  assert.equal(await envelopeStatus(envelope.envelopeId), "completed");
});

test("a link reopened after the envelope is voided says it was voided", async () => {
  const envelope = await createSentEnvelope();

  await voidSentEnvelope(
    envelope.userId,
    envelope.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database },
  );
  assert.equal(await envelopeStatus(envelope.envelopeId), "voided");

  const reopened = await unavailableState(envelope.token);

  assert.equal(reopened.state, "voided");
  assert.equal(await envelopeStatus(envelope.envelopeId), "voided");
});

test("a link reopened after its signer declined says the envelope was declined", async () => {
  const envelope = await createSentEnvelope();

  await declineSigningForToken(
    envelope.token,
    { reason: "Not what we agreed." },
    { database },
  );

  assert.equal((await unavailableState(envelope.token)).state, "declined");
});

test("a link reopened after its signer signed, with others still to sign, says they signed", async () => {
  const envelope = await createSentEnvelope({ withSecondSigner: true });

  await signEnvelope(envelope);
  assert.equal(await envelopeStatus(envelope.envelopeId), "sent");

  assert.equal(
    (await unavailableState(envelope.token)).state,
    "already-signed",
  );
});

test("a signer who signed and then sees the envelope voided is told it was voided", async () => {
  const envelope = await createSentEnvelope({ withSecondSigner: true });

  await signEnvelope(envelope);
  await voidSentEnvelope(
    envelope.userId,
    envelope.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database },
  );

  assert.equal((await unavailableState(envelope.token)).state, "voided");
});

test("a link that was never issued still reads as expired", async () => {
  const { token } = await issueSigningLink({
    expiresInSeconds: DAY,
    issuedAt: Math.floor(Date.now() / 1000),
  });

  assert.equal((await unavailableState(token)).state, "expired");
});

test("an envelope voided while its invitation fails to send stays voided, link and all", async () => {
  const envelope = await createSentEnvelope();
  const outbox = path.join(storageDir, "outbox");

  // Back to a draft with one signer waiting, ready to send.
  await database.query(
    `update envelopes set status = 'draft', sent_at = null, expires_at = null where id = $1`,
    [envelope.envelopeId],
  );
  await database.query(
    `
      update signers
      set status = 'pending', signing_token_hash = null,
        signing_token_expires_at = null, last_notified_at = null,
        consented_at = null
      where envelope_id = $1
    `,
    [envelope.envelopeId],
  );

  let voided = false;

  try {
    // Once the send has committed, the sender voids the envelope, and then
    // the invitation cannot be delivered: a file stands where the captured
    // emails go.
    const sending = afterStatement(
      database,
      (text) => text === "COMMIT" && !voided,
      async () => {
        voided = true;
        await voidSentEnvelope(
          envelope.userId,
          envelope.envelopeId,
          { senderEmail: "sam@example.test", senderName: "Sam Sender" },
          { database },
        );
        await rm(outbox, { force: true, recursive: true });
        await writeFile(outbox, "");
      },
    );

    await assert.rejects(
      sendDraftEnvelope(
        envelope.userId,
        envelope.envelopeId,
        { senderEmail: "sam@example.test", senderName: "Sam Sender" },
        { database: sending },
      ),
    );
  } finally {
    await rm(outbox, { force: true, recursive: true });
  }

  assert.ok(voided, "the send never committed");
  assert.equal(await envelopeStatus(envelope.envelopeId), "voided");

  const signer = await database.query<{
    spent: string | null;
    status: string;
  }>(
    `select status, spent_signing_token_hash as spent from signers where envelope_id = $1`,
    [envelope.envelopeId],
  );

  // The failed send leaves the voided envelope's signer as the void left
  // them, so their invitation still says it was voided.
  assert.equal(signer.rows[0]?.status, "notified");
  assert.ok(signer.rows[0]?.spent);
});
