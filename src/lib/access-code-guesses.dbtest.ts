import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { afterStatement, openTestDatabase } from "./db/test-database.ts";
import { clearRateLimitStoreForTests } from "./security/rate-limit.ts";
import { issueSigningLink } from "./services/signing-links.ts";
import { hashAccessCode } from "./signer-checks.ts";
import {
  ACCESS_CODE_MAX_FAILURES,
  SigningMutationError,
  verifySignerCheck,
} from "./signing.ts";

// Guessing a signer's access code, against a real Postgres. Wrong codes are
// counted per signer and code, so a short code cannot be found by trying
// for the week a link lasts. Run with `npm run test:db`.

process.env.APP_URL ??= "https://sign.example.test";

let database: pg.Pool;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  clearRateLimitStoreForTests();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
});

async function createEnvelopeWithAccessCode(code: string) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const signerId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const link = await issueSigningLink({
    expiresInSeconds: 3600,
    issuedAt: now,
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
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at
      ) values ($1, $2, 'Lease', 'sent', 'k.pdf', 'lease.pdf', 10, 1, $3, $4)
    `,
    [envelopeId, userId, "a".repeat(64), now],
  );
  await database.query(
    `
      insert into signers (
        id, envelope_id, name, email, sign_order, status,
        signing_token_hash, signing_token_expires_at, last_notified_at,
        access_code_hash
      ) values ($1, $2, 'Riley', $3, 1, 'notified', $4, $5, $6, $7)
    `,
    [
      signerId,
      envelopeId,
      `${signerId}@example.test`,
      link.tokenHash,
      link.exp,
      now,
      hashAccessCode(code),
    ],
  );

  return { signerId, token: link.token };
}

function tryCode(token: string, code: string) {
  return verifySignerCheck(
    token,
    { code, method: "access_code" },
    { database },
  );
}

test("a signer's wrong access codes run out, and a new code starts over", async () => {
  const { signerId, token } = await createEnvelopeWithAccessCode("1234");

  for (let attempt = 0; attempt < ACCESS_CODE_MAX_FAILURES; attempt += 1) {
    await assert.rejects(
      tryCode(token, String(5000 + attempt)),
      (error: unknown) =>
        error instanceof SigningMutationError && error.statusCode === 400,
    );
  }

  // Even the right code waits now: a guesser cannot tell when they hit it.
  await assert.rejects(
    tryCode(token, "1234"),
    (error: unknown) =>
      error instanceof SigningMutationError && error.statusCode === 429,
  );

  // The sender gives the signer a new code.
  await database.query(
    `update signers set access_code_hash = $1 where id = $2`,
    [hashAccessCode("9876"), signerId],
  );

  assert.deepEqual(await tryCode(token, "9876"), ["access_code"]);
});

test("guesses sent at the same moment cannot pass the last try together, and right codes are not counted", async () => {
  const { token } = await createEnvelopeWithAccessCode("4321");

  // Right codes along the way take nothing from the count.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await tryCode(token, "4321"), ["access_code"]);
  }

  for (let attempt = 0; attempt < ACCESS_CODE_MAX_FAILURES - 1; attempt += 1) {
    await assert.rejects(
      tryCode(token, String(6000 + attempt)),
      (error: unknown) =>
        error instanceof SigningMutationError && error.statusCode === 400,
    );
  }

  // One try is left. Five sent together, each held right after it first
  // asks about the count until all five have: only one is compared.
  const together = 5;
  let arrived = 0;
  let releaseAll!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const pool = afterStatement(
    database,
    (text) => arrived < together && text.includes("public.rate_limits"),
    async () => {
      arrived += 1;

      if (arrived === together) {
        releaseAll();
      }

      await allArrived;
    },
  );
  const results = await Promise.allSettled(
    Array.from({ length: together }, (_, offset) =>
      verifySignerCheck(
        token,
        { code: String(7000 + offset), method: "access_code" },
        { database: pool },
      ),
    ),
  );
  const statuses = results.map((result) =>
    result.status === "rejected" &&
    result.reason instanceof SigningMutationError
      ? result.reason.statusCode
      : "passed",
  );

  assert.deepEqual(
    statuses.toSorted(),
    [400, 429, 429, 429, 429],
    JSON.stringify(statuses),
  );
});

test("right codes sent at the same moment are both taken back off the count", async () => {
  const { token } = await createEnvelopeWithAccessCode("2468");

  // Both are counted before either is taken back.
  const together = 2;
  let arrived = 0;
  let releaseAll!: () => void;
  const allArrived = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const pool = afterStatement(
    database,
    (text) =>
      arrived < together && text.includes("insert into public.rate_limits"),
    async () => {
      arrived += 1;

      if (arrived === together) {
        releaseAll();
      }

      await allArrived;
    },
  );

  for (const result of await Promise.all(
    Array.from({ length: together }, () =>
      verifySignerCheck(
        token,
        { code: "2468", method: "access_code" },
        { database: pool },
      ),
    ),
  )) {
    assert.deepEqual(result, ["access_code"]);
  }

  // Every wrong try is still left.
  for (let attempt = 0; attempt < ACCESS_CODE_MAX_FAILURES; attempt += 1) {
    await assert.rejects(
      tryCode(token, String(8000 + attempt)),
      (error: unknown) =>
        error instanceof SigningMutationError && error.statusCode === 400,
    );
  }
});
