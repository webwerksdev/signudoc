import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerHooks } from "node:module";
import { after, before, beforeEach, test } from "node:test";

import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import type pg from "pg";

import type { createAppAuth as CreateAppAuth } from "./server.ts";
import { replaceDbPoolForTests } from "../db/connection.ts";
import { openTestDatabase } from "../db/test-database.ts";
import { clearRateLimitStoreForTests } from "../security/rate-limit.ts";
import { listSystemAuditEvents } from "../services/system-audit.ts";
import { invalidateSettingsCache, saveSettings } from "../settings.ts";
import { needsTwoFactorSetup } from "../sign-in-security.ts";

// Single sign-on against a real Postgres, the real Better Auth endpoints and
// a small OpenID Connect provider run here: discovery, signed ID tokens and
// nonce checks are all the real thing. Run with `npm run test:db`.

const BASE_URL = "http://localhost:3998";
const CLIENT_ID = "signudoc-test";
const PASSWORD = "a long enough passphrase";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

type Profile = {
  email?: string;
  email_verified?: unknown;
  name: string;
  sub: string;
  xms_edov?: unknown;
};

let database: pg.Pool;
let replaced: pg.Pool | null = null;
let provider: Server;
let issuer = "";
let privateKey: CryptoKey;
let publicJwk: JWK;
let nextProfile: Profile;
const codes = new Map<string, { nonce: string | null; profile: Profile }>();

async function signIdToken(profile: Profile, nonce: string | null) {
  return new SignJWT({ ...profile, ...(nonce ? { nonce } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer(issuer)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function startProvider(): Promise<void> {
  provider = createServer((request, response) => {
    const url = new URL(request.url ?? "/", issuer || "http://127.0.0.1");
    const json = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };

    if (url.pathname === "/.well-known/openid-configuration") {
      json({
        authorization_endpoint: `${issuer}/authorize`,
        id_token_signing_alg_values_supported: ["RS256"],
        issuer,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
      });
      return;
    }

    if (url.pathname === "/jwks") {
      json({ keys: [{ ...publicJwk, alg: "RS256", kid: "test", use: "sig" }] });
      return;
    }

    if (url.pathname === "/token") {
      let body = "";

      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        const code = new URLSearchParams(body).get("code") ?? "";
        const pending = codes.get(code);

        if (!pending) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }

        void signIdToken(pending.profile, pending.nonce).then((idToken) => {
          json({
            access_token: `access-${code}`,
            expires_in: 300,
            id_token: idToken,
            token_type: "Bearer",
          });
        });
      });
      return;
    }

    if (url.pathname === "/userinfo") {
      const code = (request.headers.authorization ?? "").replace(
        /^Bearer access-/,
        "",
      );
      const pending = codes.get(code);

      json(pending?.profile ?? {});
      return;
    }

    response.writeHead(404);
    response.end();
  });

  return new Promise((resolve) => {
    provider.listen(0, "127.0.0.1", () => {
      const { port } = provider.address() as AddressInfo;

      issuer = `http://127.0.0.1:${String(port)}`;
      resolve();
    });
  });
}

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

function makeAuth(extraEnv: Record<string, string> = {}) {
  return import("./server.ts").then(({ createAppAuth }) =>
    createAppAuth({
      database,
      env: {
        APP_URL: BASE_URL,
        BETTER_AUTH_SECRET:
          "test-secret-that-is-long-enough-for-better-auth-0123",
        BETTER_AUTH_URL: BASE_URL,
        EMAIL_DRIVER: "capture",
        NODE_ENV: "test",
        SSO_CLIENT_ID: CLIENT_ID,
        SSO_CLIENT_SECRET: "client-secret",
        SSO_ISSUER: issuer,
        SSO_NAME: "Acme Okta",
        ...extraEnv,
      },
      includeNextCookies: false,
    }),
  );
}

async function post(
  auth: ReturnType<typeof CreateAppAuth>,
  path: string,
  body: unknown,
  cookies: Cookies = new Map(),
) {
  const response = await auth.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(cookies),
        origin: BASE_URL,
        "x-forwarded-for": "203.0.113.9",
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

/**
 * The whole round trip: ask for the provider's sign-in page, have the
 * provider "sign in" `profile`, and follow the callback. Returns where the
 * callback sent the browser, and its cookies.
 */
async function signInWithSso(
  auth: ReturnType<typeof CreateAppAuth>,
  profile: Profile,
) {
  const cookies: Cookies = new Map();
  const started = await post(
    auth,
    "/sign-in/social",
    {
      callbackURL: `${BASE_URL}/dashboard`,
      errorCallbackURL: `${BASE_URL}/login`,
      provider: "sso",
    },
    cookies,
  );

  assert.equal(started.status, 200, JSON.stringify(started.payload));

  const authorizeUrl = new URL(String(started.payload?.url));

  assert.equal(authorizeUrl.origin, issuer);
  assert.ok(authorizeUrl.searchParams.get("code_challenge"), "PKCE is used");

  const code = randomUUID();

  nextProfile = profile;
  codes.set(code, {
    nonce: authorizeUrl.searchParams.get("nonce"),
    profile: nextProfile,
  });

  const callback = await auth.handler(
    new Request(
      `${BASE_URL}/api/auth/callback/sso?code=${code}&state=${encodeURIComponent(authorizeUrl.searchParams.get("state") ?? "")}`,
      {
        headers: {
          cookie: cookieHeader(cookies),
          "x-forwarded-for": "203.0.113.9",
        },
        method: "GET",
      },
    ),
  );

  absorbCookies(callback, cookies);

  return {
    cookies,
    location: new URL(callback.headers.get("location") ?? "", BASE_URL),
  };
}

async function sessionUser(
  auth: ReturnType<typeof CreateAppAuth>,
  cookies: Cookies,
) {
  const session = await auth.api.getSession({
    headers: new Headers({ cookie: cookieHeader(cookies) }),
  });

  return session?.user ?? null;
}

before(async () => {
  const keys = await generateKeyPair("RS256");

  privateKey = keys.privateKey;
  publicJwk = await exportJWK(keys.publicKey);
  await startProvider();
  database = await openTestDatabase();
  replaced = replaceDbPoolForTests(database);
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
  // An install that has been set up has an administrator.
  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Owner', 'owner@acme.com', true, 'admin')`,
    [randomUUID()],
  );
});

after(async () => {
  try {
    await database.query(`truncate public."user" cascade`);
    await database.query("delete from public.system_audit_events");
    await database.query("delete from public.app_settings");
    replaceDbPoolForTests(replaced ?? database);
    await database.end();
  } finally {
    provider?.close();
  }
});

test("a first sign-in through the identity provider makes a verified account and is audited", async () => {
  const auth = await makeAuth();
  const { cookies, location } = await signInWithSso(auth, {
    email: "Pat@Acme.com",
    email_verified: true,
    name: "Pat Person",
    sub: "okta-pat",
  });

  assert.equal(location.pathname, "/dashboard");

  const user = await sessionUser(auth, cookies);

  assert.equal(user?.email, "pat@acme.com");
  assert.equal(user?.emailVerified, true);

  const events = await listSystemAuditEvents({ limit: 100 }, database);
  const signedIn = events.find((event) => event.event === "sign_in_succeeded");

  assert.equal(signedIn?.actorUserId, user?.id);
  assert.deepEqual(signedIn?.metadata, { method: "sso", provider: "sso" });
});

test("someone with a password account is signed in to it, not given a second one", async () => {
  const auth = await makeAuth();
  const context = await auth.$context;
  const id = randomUUID();

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat', 'pat@acme.com', true, 'admin')`,
    [id],
  );
  await database.query(
    `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), id, await context.password.hash(PASSWORD)],
  );

  const { cookies, location } = await signInWithSso(auth, {
    email: "pat@acme.com",
    email_verified: true,
    name: "Pat",
    sub: "okta-pat",
  });

  assert.equal(location.pathname, "/dashboard");
  assert.equal((await sessionUser(auth, cookies))?.id, id);

  const { rows } = await database.query<{ count: string }>(
    `select count(*)::text as count from "user" where email = 'pat@acme.com'`,
  );

  assert.equal(rows[0]?.count, "1");
});

test("the sign-up rule holds for single sign-on too", async () => {
  await saveSettings(
    { allowedEmailDomains: ["acme.com"], signupMode: "domains" },
    database,
  );
  invalidateSettingsCache();

  const auth = await makeAuth();
  const refused = await signInWithSso(auth, {
    email: "pat@elsewhere.com",
    name: "Pat",
    sub: "google-pat",
  });

  assert.equal(refused.location.pathname, "/login");
  assert.equal(
    refused.location.searchParams.get("error"),
    "signup_domain_not_allowed",
  );
  assert.equal(await sessionUser(auth, refused.cookies), null);

  const failed = (await listSystemAuditEvents({ limit: 100 }, database)).find(
    (event) => event.event === "sign_in_failed",
  );

  assert.deepEqual(failed?.metadata, {
    method: "sso",
    provider: "sso",
    reason: "signup_domain_not_allowed",
  });

  const allowed = await signInWithSso(auth, {
    email: "sam@acme.com",
    email_verified: true,
    name: "Sam",
    sub: "google-sam",
  });

  assert.equal(allowed.location.pathname, "/dashboard");
});

test("an address the provider says is unverified is not tied to an existing account", async () => {
  const auth = await makeAuth();

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat', 'pat@acme.com', true, 'user')`,
    [randomUUID()],
  );

  const { cookies, location } = await signInWithSso(auth, {
    email: "pat@acme.com",
    email_verified: false,
    name: "Pat",
    sub: "okta-intruder",
  });

  assert.equal(location.pathname, "/login");
  assert.ok(location.searchParams.get("error"));
  assert.equal(await sessionUser(auth, cookies), null);
});

test("an address the provider does not vouch for never reaches an existing administrator", async () => {
  const auth = await makeAuth();
  const adminId = randomUUID();

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat', 'pat@acme.com', true, 'admin')`,
    [adminId],
  );

  // Left out (as Entra ID does), null, or anything that is not a plain yes.
  const claims: Array<Partial<Profile>> = [
    {},
    { email_verified: null },
    { email_verified: 1 },
    { email_verified: "yes" },
    { email_verified: "False" },
    { xms_edov: false },
  ];

  for (const [index, claim] of claims.entries()) {
    const { cookies } = await signInWithSso(auth, {
      email: "pat@acme.com",
      name: "Pat",
      sub: `intruder-${String(index)}`,
      ...claim,
    });

    assert.notEqual(
      (await sessionUser(auth, cookies))?.id,
      adminId,
      JSON.stringify(claim),
    );
  }

  const { rows } = await database.query<{ count: string }>(
    `select count(*)::text as count from account where "userId" = $1 and "providerId" = 'sso'`,
    [adminId],
  );

  assert.equal(rows[0]?.count, "0");
});

test("an Entra ID sign-in whose tenant owns the address's domain reaches the existing account", async () => {
  const auth = await makeAuth();
  const id = randomUUID();

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat', 'pat@acme.com', true, 'user')`,
    [id],
  );

  const { cookies, location } = await signInWithSso(auth, {
    email: "pat@acme.com",
    name: "Pat",
    sub: "entra-pat",
    xms_edov: true,
  });

  assert.equal(location.pathname, "/dashboard");
  assert.equal((await sessionUser(auth, cookies))?.id, id);
});

test("with password sign-in off, only the listed addresses may use a password", async () => {
  const auth = await makeAuth({
    PASSWORD_SIGN_IN: "off",
    PASSWORD_SIGN_IN_ALLOWED_EMAILS: "admin@acme.com",
  });
  const context = await auth.$context;

  for (const email of ["admin@acme.com", "pat@acme.com"]) {
    const id = randomUUID();

    await database.query(
      `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Someone', $2, true, 'user') on conflict do nothing`,
      [id, email],
    );
    await database.query(
      `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
      [randomUUID(), id, await context.password.hash(PASSWORD)],
    );
  }

  const refused = await post(auth, "/sign-in/email", {
    email: "pat@acme.com",
    password: PASSWORD,
  });

  assert.equal(refused.status, 403);
  assert.equal(refused.payload?.code, "PASSWORD_SIGN_IN_OFF");

  const reset = await post(auth, "/request-password-reset", {
    email: "pat@acme.com",
    redirectTo: `${BASE_URL}/login`,
  });

  assert.equal(reset.status, 403);

  const signUp = await post(auth, "/sign-up/email", {
    email: "new@acme.com",
    name: "New",
    password: PASSWORD,
  });

  assert.equal(signUp.status, 403);

  const breakGlass = await post(auth, "/sign-in/email", {
    email: "Admin@Acme.com",
    password: PASSWORD,
  });

  assert.equal(breakGlass.status, 200);
});

test("PASSWORD_SIGN_IN=off does nothing without single sign-on set up", async () => {
  const auth = await makeAuth({
    PASSWORD_SIGN_IN: "off",
    SSO_CLIENT_ID: "",
    SSO_CLIENT_SECRET: "",
    SSO_ISSUER: "",
  });
  const context = await auth.$context;
  const id = randomUUID();

  await database.query(
    `insert into "user" (id, name, email, "emailVerified", role) values ($1, 'Pat', 'pat@acme.com', true, 'user')`,
    [id],
  );
  await database.query(
    `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), id, await context.password.hash(PASSWORD)],
  );

  const result = await post(auth, "/sign-in/email", {
    email: "pat@acme.com",
    password: PASSWORD,
  });

  assert.equal(result.status, 200);
});

test("requiring two-step sign-in does not hold up someone who only uses single sign-on", async () => {
  const auth = await makeAuth();
  const { cookies } = await signInWithSso(auth, {
    email: "pat@acme.com",
    name: "Pat",
    sub: "okta-pat",
  });
  const user = await sessionUser(auth, cookies);

  assert.ok(user);
  assert.equal(
    await needsTwoFactorSetup({ requireTwoFactor: true }, user, { database }),
    false,
  );

  // Someone with a password still has to set it up.
  const context = await auth.$context;

  await database.query(
    `insert into account (id, "accountId", "providerId", "userId", password) values ($1, $2, 'credential', $2, $3)`,
    [randomUUID(), user.id, await context.password.hash(PASSWORD)],
  );
  assert.equal(
    await needsTwoFactorSetup({ requireTwoFactor: true }, user, { database }),
    true,
  );
});

test("an ID token posted straight to the sign-in route is refused, not signed in unaudited", async () => {
  const auth = await makeAuth();
  const token = await signIdToken(
    {
      email: "pat@acme.com",
      email_verified: true,
      name: "Pat Person",
      sub: "okta-pat",
    },
    null,
  );
  const result = await post(auth, "/sign-in/social", {
    idToken: { token },
    provider: "sso",
  });

  assert.equal(result.status, 400);
  assert.equal(result.payload?.code, "ID_TOKEN_SIGN_IN_NOT_ALLOWED");

  const accounts = await database.query(
    `select 1 from "user" where email = 'pat@acme.com'`,
  );

  assert.equal(accounts.rowCount, 0);
});
