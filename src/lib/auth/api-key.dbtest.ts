import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, before, test } from "node:test";

import type pg from "pg";

import { createApiKey } from "../api-keys.ts";
import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { clearRateLimit } from "../security/rate-limit.ts";
import type { requireApiKey as RequireApiKey } from "./api-key.ts";

// The /api/v1 auth path against a real Postgres. Run with `npm run test:db`.

// The API's responses come from next/server, which Next.js resolves for
// itself. Plain Node needs the file name.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let requireApiKey: typeof RequireApiKey;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
  ({ requireApiKey } = await import("./api-key.ts"));
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

async function createAdmin() {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, 'admin', true)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`],
  );

  return { email: `${id}@example.test`, userId: id };
}

function apiRequest(key: string, address?: string) {
  const headers = new Headers({ authorization: `Bearer ${key}` });

  if (address) {
    headers.set("x-forwarded-for", address);
  }

  return new Request("https://sign.example.test/api/v1/me", { headers });
}

test("bad keys from an address get 429 in the end, but never lock out a good key from it", async () => {
  const admin = await createAdmin();
  const { key } = await createApiKey(
    admin,
    { expiresInDays: null, name: "Billing worker", scope: "read" },
    database,
  );
  // A documentation address of its own, so no other run's count is in it.
  const address = `2001:db8::${randomBytes(2).toString("hex")}`;
  const failureKey = `api-key-failures:${address}`;
  const badKey = `sdk_${"A".repeat(43)}`;

  await clearRateLimit(failureKey);

  try {
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const refused = await requireApiKey(apiRequest(badKey, address), "read");

      assert.ok(refused instanceof Response);
      assert.equal(refused.status, 401, `bad key ${String(attempt)}`);
    }

    const turnedAway = await requireApiKey(apiRequest(badKey, address), "read");

    assert.ok(turnedAway instanceof Response);
    assert.equal(turnedAway.status, 429);
    assert.ok(Number(turnedAway.headers.get("retry-after")) >= 1);
    assert.deepEqual(await turnedAway.json(), {
      error: {
        code: "rate_limited",
        message: "Too many requests with a bad key. Try again later.",
      },
    });

    const accepted = await requireApiKey(apiRequest(key, address), "read");

    assert.ok(!(accepted instanceof Response));
    assert.equal(accepted.user.id, admin.userId);
    assert.equal(accepted.apiKey.name, "Billing worker");
  } finally {
    await clearRateLimit(failureKey);
  }
});

test("a read-only key is let in to read and refused for writing", async () => {
  const admin = await createAdmin();
  const { key } = await createApiKey(
    admin,
    { expiresInDays: 30, name: "Dashboard", scope: "read" },
    database,
  );

  const reading = await requireApiKey(apiRequest(key), "read");

  assert.ok(!(reading instanceof Response));
  assert.equal(reading.apiKey.scope, "read");

  const writing = await requireApiKey(apiRequest(key), "write");

  assert.ok(writing instanceof Response);
  assert.equal(writing.status, 403);
  assert.equal(writing.headers.get("ratelimit-limit"), "600");
  assert.deepEqual(await writing.json(), {
    error: {
      code: "forbidden",
      message: "This key is read-only. Use a key with write access.",
    },
  });
});
