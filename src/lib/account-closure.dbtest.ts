import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import {
  AccountMutationError,
  LAST_ADMIN_CLOSURE_MESSAGE,
  accountClosureBlock,
  requestAccountClosure,
} from "./account.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { listSystemAuditEvents } from "./services/system-audit.ts";

// Closing an account from Settings is refused for the last administrator,
// even when two administrators close at once. Run with `npm run test:db`.

const env = { BETTER_AUTH_SECRET: "a".repeat(40), EMAIL_DRIVER: "capture" };
const confirmation = { confirmation: "close my account" };

let database: pg.Pool;
const createdUsers: string[] = [];
let administratorsBefore: string[] = [];

before(async () => {
  database = await openTestDatabase();

  // The rule under test is about every administrator in the database, so
  // the ones other tests left behind step aside while this file runs.
  const existing = await database.query<{ id: string }>(
    `update public."user" set role = 'user' where role = 'admin' returning id`,
  );

  administratorsBefore = existing.rows.map((row) => row.id);
});

after(async () => {
  await database.query(
    `delete from account_closure_requests where user_id = any($1)`,
    [createdUsers],
  );
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.query(
    `update public."user" set role = 'admin' where id = any($1)`,
    [administratorsBefore],
  );
  await database.end();
});

async function createUser(role: "admin" | "user" = "admin") {
  const id = randomUUID();

  createdUsers.push(id);
  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, $2, $3, $4, true)
    `,
    [id, `Person ${id.slice(0, 4)}`, `${id}@example.test`, role],
  );

  return { id };
}

async function resetRoles() {
  await database.query(
    `delete from account_closure_requests where user_id = any($1)`,
    [createdUsers],
  );
  await database.query(
    `update public."user" set role = 'user' where id = any($1)`,
    [createdUsers],
  );
}

async function isQueued(userId: string) {
  const result = await database.query(
    `select 1 from account_closure_requests where user_id = $1`,
    [userId],
  );

  return result.rowCount === 1;
}

function refusedWith(message: string) {
  return (error: unknown) =>
    error instanceof AccountMutationError &&
    error.statusCode === 409 &&
    error.message === message;
}

test("the last administrator cannot close their account", async () => {
  await resetRoles();

  const admin = await createUser();

  assert.equal(
    await accountClosureBlock(admin, database, env),
    LAST_ADMIN_CLOSURE_MESSAGE,
  );
  await assert.rejects(
    requestAccountClosure(admin.id, confirmation, { database, env }),
    refusedWith(LAST_ADMIN_CLOSURE_MESSAGE),
  );
  assert.equal(await isQueued(admin.id), false);
});

test("an administrator can close once another one stays", async () => {
  await resetRoles();

  const admin = await createUser();
  const other = await createUser();

  assert.equal(await accountClosureBlock(admin, database, env), null);

  const result = await requestAccountClosure(admin.id, confirmation, {
    database,
    env,
  });

  assert.equal(result.alreadyQueued, false);
  assert.equal(await isQueued(admin.id), true);

  // The one left is now the last.
  await assert.rejects(
    requestAccountClosure(other.id, confirmation, { database, env }),
    refusedWith(LAST_ADMIN_CLOSURE_MESSAGE),
  );
});

test("someone who is not an administrator can always close", async () => {
  await resetRoles();

  const person = await createUser("user");

  assert.equal(await accountClosureBlock(person, database, env), null);
});

test("the hosted service lets anyone close their account", async () => {
  await resetRoles();

  const admin = await createUser();

  assert.equal(
    await accountClosureBlock(admin, database, { ...env, HOSTED_MODE: "1" }),
    null,
  );
});

test("two administrators closing at once cannot both go", async () => {
  await resetRoles();

  const first = await createUser();
  const second = await createUser();
  const results = await Promise.allSettled([
    requestAccountClosure(first.id, confirmation, { database, env }),
    requestAccountClosure(second.id, confirmation, { database, env }),
  ]);
  const refused = results.filter((result) => result.status === "rejected");

  assert.equal(refused.length, 1);
  assert.ok(
    refused.every(
      (result) =>
        result.status === "rejected" &&
        refusedWith(LAST_ADMIN_CLOSURE_MESSAGE)(result.reason),
    ),
  );
  assert.equal(
    Number(await isQueued(first.id)) + Number(await isQueued(second.id)),
    1,
  );
});

test("a closure request records where it was made from", async () => {
  await resetRoles();

  const person = await createUser("user");

  await requestAccountClosure(person.id, confirmation, {
    client: { ipAddress: "192.0.2.80", userAgent: "closure dbtest" },
    database,
    env,
  });

  const recorded = (
    await listSystemAuditEvents({ limit: 1000 }, database)
  ).filter(
    (event) =>
      event.event === "account_closure_requested" &&
      event.targetUserId === person.id,
  );

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.actorUserId, person.id);
  assert.equal(recorded[0]?.ipAddress, "192.0.2.80");
  assert.equal(recorded[0]?.userAgent, "closure dbtest");
});
