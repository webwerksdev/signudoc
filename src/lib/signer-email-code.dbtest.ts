import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { EMAIL_CODE_RESEND_SECONDS } from "./signer-checks.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { sendSignerEmailCode } from "./signing.ts";

// Asking for a new one-time code during the resend cooldown, against a real
// Postgres. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

const DAY = 24 * 60 * 60;

let database: pg.Pool;
let storageDir: string;
let outboxDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  globalThis.__signudocPgPool = database;
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-email-code-"));
  outboxDir = path.join(storageDir, "outbox");
  Object.assign(process.env, {
    EMAIL_CAPTURE_DIR: outboxDir,
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

/** A sent envelope whose one signer must confirm an emailed code. */
async function createEnvelopeWithEmailCode() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const email = `${signerId}@example.test`;
  const now = Math.floor(Date.now() / 1000);
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

  const link = await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now });

  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at,
        require_email_code
      ) values ($1, $2, 'Riley Signer', $3, 1, 'notified', $4, $5, $6, true)
    `,
    [signerId, envelopeId, email, link.tokenHash, link.exp, now],
  );
  await database.query(
    `
      insert into fields (
        id, envelope_id, signer_id, type, page, x, y, width, height
      ) values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.1)
    `,
    [randomUUID(), envelopeId, signerId],
  );

  return { email, signerId, token: link.token };
}

async function codeEmailsTo(email: string) {
  const files = await readdir(outboxDir).catch(() => [] as string[]);
  const messages = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(
        async (file) =>
          JSON.parse(await readFile(path.join(outboxDir, file), "utf8")) as {
            template: string;
            to: string | string[];
          },
      ),
  );

  return messages.filter(
    (message) =>
      message.template === "signing_code" &&
      (Array.isArray(message.to) ? message.to : [message.to]).includes(email),
  );
}

test("a resend during the cooldown says no new code was sent", async () => {
  const signer = await createEnvelopeWithEmailCode();

  const first = await sendSignerEmailCode(signer.token, { database });

  assert.equal(first.sent, true);
  assert.equal(first.retryAfterSeconds, 0);
  assert.equal((await codeEmailsTo(signer.email)).length, 1);

  const again = await sendSignerEmailCode(signer.token, { database });

  assert.equal(again.sent, false, "no second email went out");
  assert.equal(again.emailCodeSentAt, first.emailCodeSentAt);
  assert.ok(
    again.retryAfterSeconds > 0 &&
      again.retryAfterSeconds <= EMAIL_CODE_RESEND_SECONDS,
    `retryAfterSeconds is within the cooldown, got ${String(again.retryAfterSeconds)}`,
  );
  assert.equal((await codeEmailsTo(signer.email)).length, 1);
});

test("a resend after the cooldown sends a new code and says so", async () => {
  const signer = await createEnvelopeWithEmailCode();

  await sendSignerEmailCode(signer.token, { database });
  // Move the first send back past the cooldown.
  await database.query(
    `update signers set email_code_sent_at = email_code_sent_at - $2 where id = $1`,
    [signer.signerId, EMAIL_CODE_RESEND_SECONDS + 1],
  );

  const again = await sendSignerEmailCode(signer.token, { database });

  assert.equal(again.sent, true);
  assert.equal(again.retryAfterSeconds, 0);
  assert.equal((await codeEmailsTo(signer.email)).length, 2);
});
