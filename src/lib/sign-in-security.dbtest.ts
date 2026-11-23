import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import type { createAppAuth as CreateAppAuth } from "./auth/server.ts";
import { replaceDbPoolForTests } from "./db/connection.ts";
import { openTestDatabase } from "./db/test-database.ts";
import { clearRateLimitStoreForTests } from "./security/rate-limit.ts";
import { UNKNOWN_ADDRESS_FAILURES_RECORDED_PER_HOUR } from "./auth/sign-in-events.ts";
import {
  listSystemAuditEvents,
  verifySystemAuditChain,
} from "./services/system-audit.ts";
import { invalidateSettingsCache, saveSettings } from "./settings.ts";
import { enforceSessionLimits } from "./session-controls.ts";
import {
  MAX_FAILED_SIGN_INS,
  resetTwoFactor,
  setTwoFactorRequirement,
  SignInSecurityError,
} from "./sign-in-security.ts";

// Sign-in security against a real Postgres and the real Better Auth
// endpoints: the lockout after wrong passwords, two-step sign-in, and what
// each of them writes to the install's audit trail. Run with
// `npm run test:db`.

const BASE_URL = "http://localhost:3999";
const PASSWORD = "a long enough passphrase";

const env = {
  APP_URL: BASE_URL,
  BETTER_AUTH_SECRET: "test-secret-that-is-long-enough-for-better-auth-0123",
  BETTER_AUTH_URL: BASE_URL,
  EMAIL_DRIVER: "capture",
  NODE_ENV: "test",
};

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let auth: ReturnType<typeof CreateAppAuth>;

// The auth server imports next/headers and next/navigation, which Next.js
// resolves for itself. Plain Node needs the file name.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

type Cookies = Map<string, string>;

function cookieHeader(cookies: Cookies): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function absorbCookies(response: Response, cookies: Cookies) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const index = pair?.indexOf("=") ?? -1;

    if (!pair || index < 0) {
      continue;
    }

    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();

    if (value === "" || /max-age=0/i.test(line)) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
}

async function call(
  path: string,
  body: unknown,
  cookies: Cookies = new Map(),
  ipAddress = "203.0.113.7",
): Promise<{ payload: Record<string, unknown> | null; status: number }> {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(cookies),
        origin: BASE_URL,
        "user-agent": "sign-in-security dbtest",
        "x-forwarded-for": ipAddress,
      },
      method: "POST",
    }),
  );

  absorbCookies(response, cookies);

  return {
    payload: (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null,
    status: response.status,
  };
}

async function createVerifiedUser(email: string, role = "user") {
  const context = await auth.$context;
  const id = randomUUID();

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat Person', $2, true, $3)`,
    [id, email, role],
  );
  await database.query(
    `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), id, await context.password.hash(PASSWORD)],
  );

  return id;
}

async function signIn(email: string, password = PASSWORD) {
  const cookies: Cookies = new Map();
  const result = await call("/sign-in/email", { email, password }, cookies);

  return { ...result, cookies };
}

function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";

  for (const character of value.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];

  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }

  return Buffer.from(bytes);
}

/** RFC 6238, as an authenticator app works it out. */
function totp(totpURI: string, at = Date.now()): string {
  const secret = new URL(totpURI).searchParams.get("secret") ?? "";
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));

  const digest = createHmac("sha1", base32Decode(secret))
    .update(counter)
    .digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0xf;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;

  return String(value).padStart(6, "0");
}

async function enableTwoFactor(email: string) {
  const session = await signIn(email);

  assert.equal(session.status, 200);

  const enabled = await call(
    "/two-factor/enable",
    { issuer: "Acme Sign", password: PASSWORD },
    session.cookies,
  );

  assert.equal(enabled.status, 200, JSON.stringify(enabled.payload));

  const totpURI = String(enabled.payload?.totpURI);
  const backupCodes = enabled.payload?.backupCodes as string[];
  const verified = await call(
    "/two-factor/verify-totp",
    { code: totp(totpURI) },
    session.cookies,
  );

  assert.equal(verified.status, 200, JSON.stringify(verified.payload));

  return { backupCodes, cookies: session.cookies, totpURI };
}

async function events(type?: string) {
  const all = await listSystemAuditEvents({ limit: 1000 }, database);

  return type ? all.filter((event) => event.event === type) : all;
}

before(async () => {
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);

  const { createAppAuth } = await import("./auth/server.ts");

  auth = createAppAuth({ database, env, includeNextCookies: false });
});

beforeEach(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.system_audit_events");
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  await database.query("delete from public.verification");
  clearRateLimitStoreForTests();
  invalidateSettingsCache();
  await saveSettings({ signupMode: "open" }, database);
});

after(async () => {
  await database.query(`truncate public."user" cascade`);
  await database.query("delete from public.system_audit_events");
  await database.query("delete from public.app_settings");
  await database.query("delete from public.rate_limits");
  replaceDbPoolForTests(replaced ?? database);
  await database.end();
});

test("a password sign-in is recorded, with where it came from", async () => {
  const userId = await createVerifiedUser("pat@acme.com");
  const result = await signIn("pat@acme.com");

  assert.equal(result.status, 200);

  const [event] = await events("sign_in_succeeded");

  assert.equal(event?.actorUserId, userId);
  assert.equal(event?.ipAddress, "203.0.113.7");
  assert.equal(event?.userAgent, "sign-in-security dbtest");
  assert.deepEqual(event?.metadata, { method: "password" });
  assert.deepEqual(await verifySystemAuditChain(database), {
    events: (await events()).length,
    ok: true,
  });
});

test("a password reset is recorded, with where it came from", async () => {
  const userId = await createVerifiedUser("pat@acme.com");
  const token = randomUUID();

  // The token the emailed reset link carries, as Better Auth stores it.
  await database.query(
    `insert into verification (id, identifier, value, "expiresAt") values ($1, $2, $3, now() + interval '1 hour')`,
    [randomUUID(), `reset-password:${token}`, userId],
  );

  const reset = await call(
    "/reset-password",
    { newPassword: "a different long passphrase", token },
    new Map(),
    "198.51.100.23",
  );

  assert.equal(reset.status, 200, JSON.stringify(reset.payload));

  const [event] = await events("password_reset");

  assert.equal(event?.actorUserId, userId);
  assert.equal(event?.targetUserId, userId);
  assert.equal(event?.ipAddress, "198.51.100.23");
  assert.equal(event?.userAgent, "sign-in-security dbtest");
});

test("ten wrong passwords stop sign-in for the address, even with the right one", async () => {
  await createVerifiedUser("pat@acme.com");

  for (let attempt = 1; attempt <= MAX_FAILED_SIGN_INS; attempt += 1) {
    const result = await signIn("pat@acme.com", "not the right password!!");

    assert.equal(result.status, 401, `attempt ${String(attempt)}`);
  }

  const locked = await signIn("pat@acme.com");

  assert.equal(locked.status, 429);
  assert.equal(locked.payload?.code, "SIGN_IN_LOCKED");

  const failures = await events("sign_in_failed");

  assert.equal(failures.length, MAX_FAILED_SIGN_INS);
  assert.equal(failures[0]?.metadata?.reason, "INVALID_EMAIL_OR_PASSWORD");
  assert.equal((await events("sign_in_locked")).length, 1);
  assert.equal((await events("sign_in_succeeded")).length, 0);
});

test("an address with no account is stopped the same way", async () => {
  for (let attempt = 1; attempt <= MAX_FAILED_SIGN_INS; attempt += 1) {
    await signIn("nobody@acme.com", "not the right password!!");
  }

  const locked = await signIn("nobody@acme.com", "not the right password!!");

  assert.equal(locked.status, 429);
  assert.equal(locked.payload?.code, "SIGN_IN_LOCKED");
});

test("tries at made-up addresses from one place are recorded only up to an hourly number", async () => {
  for (
    let attempt = 0;
    attempt < UNKNOWN_ADDRESS_FAILURES_RECORDED_PER_HOUR + 5;
    attempt += 1
  ) {
    await signIn(
      `nobody-${String(attempt)}@acme.com`,
      "not the right password!!",
    );
  }

  const failures = await events("sign_in_failed");

  assert.ok(failures.length > 0);
  assert.ok(
    failures.length <= UNKNOWN_ADDRESS_FAILURES_RECORDED_PER_HOUR,
    String(failures.length),
  );
});

test("a sign-in that works forgets the wrong passwords before it", async () => {
  await createVerifiedUser("pat@acme.com");

  for (let attempt = 1; attempt < MAX_FAILED_SIGN_INS; attempt += 1) {
    await signIn("pat@acme.com", "not the right password!!");
  }

  assert.equal((await signIn("pat@acme.com")).status, 200);
  assert.equal(
    (await signIn("pat@acme.com", "not the right password!!")).status,
    401,
  );
  assert.equal((await signIn("pat@acme.com")).status, 200);
});

test("two-step sign-in: set up, then asked for at every sign-in", async () => {
  const userId = await createVerifiedUser("pat@acme.com");
  const { backupCodes, totpURI } = await enableTwoFactor("pat@acme.com");

  assert.equal(backupCodes.length, 10);
  assert.equal((await events("two_factor_enabled"))[0]?.actorUserId, userId);

  // The password alone no longer signs in.
  const first = await signIn("pat@acme.com");

  assert.equal(first.status, 200);
  assert.equal(first.payload?.twoFactorRedirect, true);
  assert.equal(
    [...first.cookies.keys()].some((name) => name.endsWith("session_token")),
    false,
  );

  // Two sign-ins recorded so far: the one that set it up, and none for this
  // one until the second step is done.
  assert.equal((await events("sign_in_succeeded")).length, 1);

  const wrong = await call(
    "/two-factor/verify-totp",
    { code: "000000" === totp(totpURI) ? "111111" : "000000" },
    first.cookies,
  );

  assert.equal(wrong.status, 401);
  assert.equal(
    (await events("sign_in_failed"))[0]?.metadata?.reason,
    "INVALID_CODE",
  );
  assert.equal((await events("sign_in_failed"))[0]?.actorUserId, userId);

  const right = await call(
    "/two-factor/verify-totp",
    { code: totp(totpURI) },
    first.cookies,
  );

  assert.equal(right.status, 200, JSON.stringify(right.payload));

  const signedIn = (await events("sign_in_succeeded"))[0];

  assert.deepEqual(signedIn?.metadata, {
    method: "password",
    secondStep: "authenticator",
  });

  // A backup code works once.
  const second = await signIn("pat@acme.com");
  const backup = await call(
    "/two-factor/verify-backup-code",
    { code: backupCodes[0] },
    second.cookies,
  );

  assert.equal(backup.status, 200, JSON.stringify(backup.payload));
  assert.equal(
    (await events("sign_in_succeeded"))[0]?.metadata?.secondStep,
    "backup_code",
  );

  const third = await signIn("pat@acme.com");
  const reused = await call(
    "/two-factor/verify-backup-code",
    { code: backupCodes[0] },
    third.cookies,
  );

  assert.equal(reused.status, 401);
});

test("turning two-step sign-in off and making new codes are recorded", async () => {
  await createVerifiedUser("pat@acme.com");

  const { cookies } = await enableTwoFactor("pat@acme.com");
  const codes = await call(
    "/two-factor/generate-backup-codes",
    { password: PASSWORD },
    cookies,
  );

  assert.equal(codes.status, 200);
  assert.equal((await events("two_factor_backup_codes_regenerated")).length, 1);

  const disabled = await call(
    "/two-factor/disable",
    { password: PASSWORD },
    cookies,
  );

  assert.equal(disabled.status, 200, JSON.stringify(disabled.payload));
  assert.equal((await events("two_factor_disabled")).length, 1);
});

test("requiring two-step sign-in: the administrator must use it first, and nobody can turn theirs off", async () => {
  const adminId = await createVerifiedUser("admin@acme.com", "admin");
  const actor = { email: "admin@acme.com", userId: adminId };

  await assert.rejects(
    setTwoFactorRequirement(actor, true, database),
    (error: unknown) =>
      error instanceof SignInSecurityError && error.statusCode === 409,
  );

  const { cookies } = await enableTwoFactor("admin@acme.com");

  await setTwoFactorRequirement(actor, true, database);
  invalidateSettingsCache();

  const changed = await events("two_factor_requirement_changed");

  assert.deepEqual(changed[0]?.metadata, { from: false, to: true });

  const disabled = await call(
    "/two-factor/disable",
    { password: PASSWORD },
    cookies,
  );

  assert.equal(disabled.status, 403);
  assert.equal(disabled.payload?.code, "TWO_FACTOR_REQUIRED_BY_ADMINISTRATOR");

  const member = await createVerifiedUser("member@acme.com");

  await assert.rejects(
    setTwoFactorRequirement(
      { email: "member@acme.com", userId: member },
      false,
      database,
    ),
    (error: unknown) =>
      error instanceof SignInSecurityError && error.statusCode === 403,
  );
});

test("an administrator's reset turns someone's two-step sign-in off and signs them out", async () => {
  const adminId = await createVerifiedUser("admin@acme.com", "admin");
  const memberId = await createVerifiedUser("member@acme.com");

  await enableTwoFactor("member@acme.com");
  await resetTwoFactor(
    { email: "admin@acme.com", userId: adminId },
    memberId,
    database,
  );

  const row = await database.query<{
    sessions: number;
    twoFactorEnabled: boolean;
    secrets: number;
  }>(
    `
      select
        u."twoFactorEnabled" as "twoFactorEnabled",
        (select count(*)::int from session s where s."userId" = u.id) as sessions,
        (select count(*)::int from "twoFactor" t where t."userId" = u.id) as secrets
      from "user" u where u.id = $1
    `,
    [memberId],
  );

  assert.deepEqual(row.rows[0], {
    secrets: 0,
    sessions: 0,
    twoFactorEnabled: false,
  });

  const [reset] = await events("two_factor_reset");

  assert.equal(reset?.actorUserId, adminId);
  assert.equal(reset?.targetUserId, memberId);

  // The password alone signs them in again.
  const again = await signIn("member@acme.com");

  assert.equal(again.status, 200);
  assert.equal(again.payload?.twoFactorRedirect, undefined);
});

test("signing out is recorded", async () => {
  const userId = await createVerifiedUser("pat@acme.com");
  const { cookies } = await signIn("pat@acme.com");
  const result = await call("/sign-out", {}, cookies);

  assert.equal(result.status, 200);
  assert.equal((await events("signed_out"))[0]?.actorUserId, userId);
});

test("signing out everywhere ends every session and is recorded", async () => {
  const userId = await createVerifiedUser("pat@acme.com");
  const first = await signIn("pat@acme.com");

  await signIn("pat@acme.com");

  const result = await call("/revoke-sessions", {}, first.cookies);

  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal((await events("sessions_revoked"))[0]?.actorUserId, userId);

  const left = await database.query<{ total: number }>(
    `select count(*)::int as total from session where "userId" = $1`,
    [userId],
  );

  assert.equal(left.rows[0]?.total, 0);
});

test("session limits end idle and old sessions, and record use", async () => {
  const userId = await createVerifiedUser("pat@acme.com");

  await signIn("pat@acme.com");

  const row = await database.query<{ createdAt: Date; token: string }>(
    `select token, "createdAt" as "createdAt" from session where "userId" = $1`,
    [userId],
  );
  const token = row.rows[0]?.token ?? "";
  const created = Math.floor((row.rows[0]?.createdAt.getTime() ?? 0) / 1000);
  const limits = { sessionIdleMinutes: 30, sessionMaxHours: 8 };

  assert.equal(
    await enforceSessionLimits(token, limits, {
      database,
      nowSeconds: created + 20 * 60,
    }),
    true,
  );

  const touched = await database.query<{ lastActiveAt: string }>(
    `select last_active_at as "lastActiveAt" from session where token = $1`,
    [token],
  );

  assert.equal(Number(touched.rows[0]?.lastActiveAt), created + 20 * 60);
  // Counted from that use, not from sign-in.
  assert.equal(
    await enforceSessionLimits(token, limits, {
      database,
      nowSeconds: created + 45 * 60,
    }),
    true,
  );
  assert.equal(
    await enforceSessionLimits(token, limits, {
      database,
      nowSeconds: created + 45 * 60 + 30 * 60,
    }),
    false,
  );

  const gone = await database.query(`select 1 from session where token = $1`, [
    token,
  ]);

  assert.equal(gone.rowCount, 0);
  assert.equal(await enforceSessionLimits(token, limits, { database }), false);
});

test("an ended session cannot use the auth server's account actions, even with its cookie cache", async () => {
  const userId = await createVerifiedUser("pat@acme.com");
  const session = await signIn("pat@acme.com");

  // Signed out everywhere from another device: the row is gone, but the
  // signed cookie cache still vouches for the session for a few minutes.
  await database.query(`delete from session where "userId" = $1`, [userId]);

  const changed = await call(
    "/change-password",
    { currentPassword: PASSWORD, newPassword: `${PASSWORD} again` },
    session.cookies,
  );

  assert.equal(changed.status, 401, JSON.stringify(changed.payload));
  assert.equal(changed.payload?.code, "SESSION_ENDED");
  assert.equal((await events("password_changed")).length, 0);

  // Past the install's idle limit, the same.
  const later = await signIn("pat@acme.com");

  await saveSettings({ sessionIdleMinutes: 15 }, database);
  invalidateSettingsCache();
  await database.query(
    `update session set last_active_at = extract(epoch from now())::int - 3600 where "userId" = $1`,
    [userId],
  );

  const enabled = await call(
    "/two-factor/enable",
    { password: PASSWORD },
    later.cookies,
  );

  assert.equal(enabled.status, 401, JSON.stringify(enabled.payload));

  // Signing in again is never in the way.
  assert.equal((await signIn("pat@acme.com")).status, 200);
});

test("a device is never trusted to skip the second step", async () => {
  await createVerifiedUser("pat@acme.com");

  const { totpURI } = await enableTwoFactor("pat@acme.com");
  const first = await signIn("pat@acme.com");
  const trusted = await call(
    "/two-factor/verify-totp",
    { code: totp(totpURI), trustDevice: true },
    first.cookies,
  );

  assert.equal(trusted.status, 400);
  assert.equal(trusted.payload?.code, "TRUST_DEVICE_NOT_ALLOWED");
  assert.equal(
    [...first.cookies.keys()].some((name) => name.includes("trust_device")),
    false,
  );
});

test("confirming an authenticator with a leftover challenge cookie is recorded as set-up, not a sign-in", async () => {
  const userId = await createVerifiedUser("pat@acme.com");

  // A challenge cookie left over from a sign-in that was never finished,
  // before an administrator reset this person's two-step sign-in.
  await enableTwoFactor("pat@acme.com");

  const abandoned = await signIn("pat@acme.com");

  assert.equal(abandoned.payload?.twoFactorRedirect, true);
  await database.query(
    `update "user" set "twoFactorEnabled" = false where id = $1`,
    [userId],
  );
  await database.query(`delete from "twoFactor" where "userId" = $1`, [userId]);
  await database.query("delete from public.system_audit_events");

  const session = await signIn("pat@acme.com");

  for (const [name, value] of abandoned.cookies) {
    if (name.includes("two_factor")) {
      session.cookies.set(name, value);
    }
  }

  const enabled = await call(
    "/two-factor/enable",
    { password: PASSWORD },
    session.cookies,
  );

  assert.equal(enabled.status, 200, JSON.stringify(enabled.payload));

  const before = (await events("sign_in_succeeded")).length;
  const verified = await call(
    "/two-factor/verify-totp",
    { code: totp(String(enabled.payload?.totpURI)) },
    session.cookies,
  );

  assert.equal(verified.status, 200, JSON.stringify(verified.payload));
  assert.equal((await events("two_factor_enabled"))[0]?.actorUserId, userId);
  assert.equal((await events("sign_in_succeeded")).length, before);
});
