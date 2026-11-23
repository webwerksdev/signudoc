import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import type { DbExecutor } from "../db/connection.ts";
import {
  clearRateLimitStoreForTests,
  consumeRateLimit,
  consumeRateLimitInMemory,
  refundRateLimit,
} from "./rate-limit.ts";

// The statement itself is exercised against a real Postgres in
// rate-limit.dbtest.ts. These tests cover what happens around it.

const MINUTE = 60 * 1000;
const START = 1_800_000_000_000;

type Query = { text: string; values: unknown[] };

function fakeDatabase(
  respond: (query: Query) => { count: number; expires_at: number } | Error,
) {
  const queries: Query[] = [];
  const database = {
    query: (text: string, values: unknown[]) => {
      const query = { text, values };

      queries.push(query);

      const response = respond(query);

      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve({ rowCount: 1, rows: [response] });
    },
  } as unknown as DbExecutor;

  return { database, queries };
}

beforeEach(() => {
  clearRateLimitStoreForTests();
});

test("in memory, requests up to the limit are allowed and the next is not", () => {
  const input = { key: "contact:1.2.3.4", limit: 3, windowMs: MINUTE };

  for (let request = 0; request < 3; request += 1) {
    assert.equal(
      consumeRateLimitInMemory({ ...input, now: START + request }).allowed,
      true,
    );
  }

  assert.deepEqual(consumeRateLimitInMemory({ ...input, now: START + 10 }), {
    allowed: false,
    count: 4,
    countedIn: "memory",
    retryAfterSeconds: 60,
  });
});

test("in memory, the wait shrinks as the window runs out and trying again does not extend it", () => {
  const input = { key: "contact:1.2.3.4", limit: 1, windowMs: MINUTE };

  consumeRateLimitInMemory({ ...input, now: START });

  assert.equal(
    consumeRateLimitInMemory({ ...input, now: START + 15_000 })
      .retryAfterSeconds,
    45,
  );
  assert.equal(
    consumeRateLimitInMemory({ ...input, now: START + 59_500 })
      .retryAfterSeconds,
    1,
  );
  assert.equal(
    consumeRateLimitInMemory({ ...input, now: START + MINUTE }).allowed,
    true,
  );
});

test("in memory, each key has its own count", () => {
  const limit = { limit: 1, windowMs: MINUTE };

  assert.equal(
    consumeRateLimitInMemory({ ...limit, key: "a", now: START }).allowed,
    true,
  );
  assert.equal(
    consumeRateLimitInMemory({ ...limit, key: "b", now: START }).allowed,
    true,
  );
  assert.equal(
    consumeRateLimitInMemory({ ...limit, key: "a", now: START }).allowed,
    false,
  );
});

test("the database's count decides, and only a hash of the key is sent to it", async () => {
  const { database, queries } = fakeDatabase(() => ({
    count: 6,
    expires_at: START + 30_000,
  }));

  const decision = await consumeRateLimit(
    {
      key: "signing:secret-signing-token",
      limit: 5,
      now: START,
      windowMs: MINUTE,
    },
    { database },
  );

  assert.deepEqual(decision, {
    allowed: false,
    count: 6,
    countedIn: "database",
    retryAfterSeconds: 30,
  });

  const [hashedKey, now, windowMs] = queries[0]?.values ?? [];

  assert.match(String(hashedKey), /^[0-9a-f]{64}$/);
  assert.equal(now, START);
  assert.equal(windowMs, MINUTE);
  assert.equal(JSON.stringify(queries).includes("secret-signing-token"), false);
});

test("a count within the limit is allowed", async () => {
  const { database } = fakeDatabase(() => ({
    count: 5,
    expires_at: START + MINUTE,
  }));

  assert.equal(
    (
      await consumeRateLimit(
        { key: "k", limit: 5, now: START, windowMs: MINUTE },
        { database },
      )
    ).allowed,
    true,
  );
});

test("when the database cannot be used the limit is still enforced, from memory", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const { database } = fakeDatabase(
    () => new Error('relation "public.rate_limits" does not exist'),
  );
  const input = { key: "contact:1.2.3.4", limit: 2, windowMs: MINUTE };
  const decisions = [];

  for (let request = 0; request < 3; request += 1) {
    decisions.push(
      await consumeRateLimit({ ...input, now: START + request }, { database }),
    );
  }

  assert.deepEqual(
    decisions.map((decision) => decision.allowed),
    [true, true, false],
  );
  // Said once, not once per request.
  assert.equal(warn.mock.callCount(), 1);
});

test("a refund goes to the store that counted the request", async () => {
  const input = {
    key: "access:signer:code",
    limit: 5,
    now: START,
    windowMs: MINUTE,
  };
  const down = fakeDatabase(() => new Error("connection refused"));

  // Counted in memory while the database could not be asked.
  await consumeRateLimit(input, { database: down.database });
  const second = await consumeRateLimit(input, { database: down.database });

  assert.equal(second.countedIn, "memory");

  // The database is back by the time of the refund: memory is still where
  // the count is taken off, and the database is not asked.
  const up = fakeDatabase(() => ({ count: 0, expires_at: START + MINUTE }));

  await refundRateLimit(input.key, second, {
    database: up.database,
    now: START,
  });

  assert.equal(up.queries.length, 0);
  assert.equal(consumeRateLimitInMemory(input).count, 2);

  // Counted in the database: the database is where it comes off.
  await refundRateLimit(
    input.key,
    { countedIn: "database" },
    { database: up.database, now: START },
  );

  assert.equal(up.queries.length, 1);
  assert.match(up.queries[0]!.text, /count = greatest\(count - 1, 0\)/);
});
