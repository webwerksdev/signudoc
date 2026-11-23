import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import { voidSentEnvelope } from "./envelopes.ts";
import { listAuditEventsForEnvelope } from "./services/audit.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";

// Who hears that an envelope was voided, against a real Postgres. Run with
// `npm run test:db`.

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
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-void-"));
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

type SignerSetup = {
  status: "pending" | "notified" | "signed";
};

/** A sent envelope with signers in order, each at the given status. */
async function createSentEnvelope(signerSetups: readonly SignerSetup[]) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
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

  const signers: { email: string; id: string; status: string }[] = [];

  for (const [index, setup] of signerSetups.entries()) {
    const signerId = randomUUID();
    const email = `${signerId}@example.test`;
    const link =
      setup.status === "notified"
        ? await issueSigningLink({ expiresInSeconds: DAY, issuedAt: now })
        : null;

    await database.query(
      `
        insert into signers (
          id, envelope_id, name, email, sign_order, status,
          signing_token_hash, signing_token_expires_at, last_notified_at,
          signed_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        signerId,
        envelopeId,
        `Signer ${String(index + 1)}`,
        email,
        index + 1,
        setup.status,
        link?.tokenHash ?? null,
        link?.exp ?? null,
        setup.status === "pending" ? null : now,
        setup.status === "signed" ? now : null,
      ],
    );
    await database.query(
      `
        insert into fields (
          id, envelope_id, signer_id, type, page, x, y, width, height
        ) values ($1, $2, $3, 'signature', 1, 0.1, 0.1, 0.2, 0.1)
      `,
      [randomUUID(), envelopeId, signerId],
    );
    signers.push({ email, id: signerId, status: setup.status });
  }

  return { envelopeId, signers, userId };
}

async function capturedVoidNotices() {
  const files = await readdir(outboxDir).catch(() => [] as string[]);
  const messages = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(
        async (file) =>
          JSON.parse(await readFile(path.join(outboxDir, file), "utf8")) as {
            template: string;
            text: string;
            to: string | string[];
          },
      ),
  );

  return messages.filter((message) => message.template === "void_notification");
}

function noticesTo(
  notices: Awaited<ReturnType<typeof capturedVoidNotices>>,
  email: string,
) {
  return notices.filter((notice) =>
    (Array.isArray(notice.to) ? notice.to : [notice.to]).includes(email),
  );
}

test("voiding emails the current signer and those who already signed, not those still waiting", async () => {
  const envelope = await createSentEnvelope([
    { status: "signed" },
    { status: "notified" },
    { status: "pending" },
  ]);
  const [signedSigner, currentSigner, waitingSigner] = envelope.signers;

  assert.ok(signedSigner && currentSigner && waitingSigner);

  await voidSentEnvelope(
    envelope.userId,
    envelope.envelopeId,
    { senderEmail: "sam@example.test", senderName: "Sam Sender" },
    { database },
  );

  const notices = await capturedVoidNotices();

  assert.equal(noticesTo(notices, signedSigner.email).length, 1);
  assert.equal(noticesTo(notices, currentSigner.email).length, 1);
  assert.equal(noticesTo(notices, waitingSigner.email).length, 0);
  assert.match(
    noticesTo(notices, signedSigner.email)[0]?.text ?? "",
    /the document you signed will not be completed/,
  );
  assert.doesNotMatch(
    noticesTo(notices, currentSigner.email)[0]?.text ?? "",
    /the document you signed/,
  );

  const auditEvents = await listAuditEventsForEnvelope(
    envelope.envelopeId,
    database,
  );
  const voidEmailRecipients = auditEvents
    .filter(
      (event) =>
        event.event === "email_sent" &&
        event.metadata?.template === "void_notification",
    )
    .map((event) => event.metadata?.signerId)
    .sort();

  assert.deepEqual(
    voidEmailRecipients,
    [signedSigner.id, currentSigner.id].sort(),
  );

  // The signer who already signed keeps that status; only the open link of
  // the current signer is cleared.
  const { rows } = await database.query<{
    id: string;
    signing_token_hash: string | null;
    status: string;
  }>(
    `select id, status, signing_token_hash from signers where envelope_id = $1`,
    [envelope.envelopeId],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));

  assert.equal(byId.get(signedSigner.id)?.status, "signed");
  assert.equal(byId.get(currentSigner.id)?.signing_token_hash, null);
});
