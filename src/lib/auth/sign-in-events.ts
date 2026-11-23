import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";

import { getDb, queryOne } from "../db/connection.ts";
import { logSecurityEvent } from "../security/logging.ts";
import { consumeRateLimit } from "../security/rate-limit.ts";
import { enforceSessionLimits } from "../session-controls.ts";
import { getSettings, isMissingSchemaError } from "../settings.ts";
import {
  getClientIpAddress,
  getRequestUserAgent,
} from "../security/request.ts";
import {
  recordSystemAuditEvent,
  type RecordSystemAuditEventInput,
  type SystemAuditEventType,
} from "../services/system-audit.ts";
import {
  clearFailedSignIns,
  countFailedSignIn,
  getSignInLockState,
  MAX_FAILED_SIGN_INS,
  SIGN_IN_LOCKED_MESSAGE,
} from "../sign-in-security.ts";

// Puts sign-ins and changes to how people sign in into the install's audit
// trail, and stops sign-in for an address after too many wrong passwords
// (sign-in-security.ts has the rules).
//
// It is a Better Auth plugin, listed after the two-factor plugin, because
// plugin hooks run in the order the plugins are listed: by the time this
// one sees a password sign-in, the two-factor plugin has already turned it
// into a request for the second step, or let it through.

const TWO_FACTOR_COOKIE_NAME = "two_factor";

const SECOND_STEP_PATHS = new Set([
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/two-factor/verify-totp",
]);

// Paths whose actor is only known before the endpoint runs: each replaces
// or ends the session it was called with.
const SESSION_FIRST_PATHS = new Set([
  "/revoke-sessions",
  "/sign-out",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
]);

const SESSION_FIRST_EVENTS: Record<string, SystemAuditEventType> = {
  "/revoke-sessions": "sessions_revoked",
  "/sign-out": "signed_out",
  "/two-factor/disable": "two_factor_disabled",
  "/two-factor/generate-backup-codes": "two_factor_backup_codes_regenerated",
};

// Paths that do not act on the caller's session, so a stale one does not
// stand in their way: signing in again, or reading the session (the app's
// own session check in auth/server.ts applies the limits to that).
function skipsSessionLimits(path: string): boolean {
  return (
    path === "/get-session" ||
    path === "/sign-out" ||
    path === "/ok" ||
    path === "/error" ||
    path === "/request-password-reset" ||
    path === "/verify-email" ||
    path.startsWith("/reset-password") ||
    path.startsWith("/sign-in/") ||
    path.startsWith("/sign-up/") ||
    path.startsWith("/callback/") ||
    path.startsWith("/oauth2/callback/")
  );
}

type Actor = { email: string; userId: string };

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

function readEmail(body: unknown): string | null {
  if (
    typeof body === "object" &&
    body !== null &&
    "email" in body &&
    typeof body.email === "string" &&
    body.email.trim()
  ) {
    return body.email.trim().toLowerCase();
  }

  return null;
}

function readUser(value: unknown): { email: string; id: string } | null {
  if (typeof value !== "object" || value === null || !("user" in value)) {
    return null;
  }

  const user: unknown = value.user;

  if (
    typeof user === "object" &&
    user !== null &&
    "id" in user &&
    typeof user.id === "string" &&
    "email" in user &&
    typeof user.email === "string"
  ) {
    return { email: user.email, id: user.id };
  }

  return null;
}

function readFailureCode(returned: unknown): string {
  if (isAPIError(returned)) {
    const body: unknown = returned.body;

    if (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
    ) {
      return body.code;
    }

    return returned.status ? String(returned.status) : "error";
  }

  return "error";
}

function requestDetails(ctx: HookContext) {
  const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();

  return {
    ipAddress: getClientIpAddress(headers),
    userAgent: getRequestUserAgent(headers),
  };
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    getDb(),
    `SELECT id FROM "user" WHERE lower(email) = $1`,
    [email],
  );

  return row?.id ?? null;
}

/** Failed sign-ins to addresses with no account recorded per hour per address. */
export const UNKNOWN_ADDRESS_FAILURES_RECORDED_PER_HOUR = 20;

async function mayRecordUnknownAddressFailure(
  ctx: HookContext,
): Promise<boolean> {
  const decision = await consumeRateLimit({
    key: `audit-unknown-sign-in:${requestDetails(ctx).ipAddress ?? "unknown"}`,
    limit: UNKNOWN_ADDRESS_FAILURES_RECORDED_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });

  return decision.allowed;
}

/**
 * Writes one event. A sign-in is never refused or undone because its record
 * could not be written; the failure is logged instead.
 */
async function record(
  ctx: HookContext,
  input: Omit<RecordSystemAuditEventInput, "ipAddress" | "userAgent">,
) {
  try {
    await recordSystemAuditEvent({ ...input, ...requestDetails(ctx) });
  } catch (error) {
    logSecurityEvent("error", {
      category: "sign_in_audit_failure",
      message: `Could not record "${input.event}" in the audit trail.`,
      metadata: { error: error instanceof Error ? error.message : "unknown" },
      userId: input.actorUserId ?? null,
    });
  }
}

export function signInEvents() {
  const sessionActors = new WeakMap<Request, Actor>();
  // Whether a second-step check came with a signed-in session (someone
  // confirming the authenticator they are setting up) or not (the second
  // step of a sign-in). A leftover challenge cookie does not decide it.
  const secondStepWithSession = new WeakMap<Request, boolean>();

  return {
    id: "signudoc-sign-in-events",
    hooks: {
      before: [
        {
          // The install's session limits (session-controls.ts) apply to the
          // auth server's own account actions too: changing a password or
          // email, managing two-step sign-in, listing sessions. Without
          // this, the signed cookie cache would let an ended or expired
          // session use them for a few more minutes.
          matcher: (ctx) => !skipsSessionLimits(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx).catch(() => null);

            if (!session) {
              return;
            }

            let allowed = true;

            try {
              allowed = await enforceSessionLimits(
                session.session.token,
                await getSettings(),
              );
            } catch (error) {
              if (!isMissingSchemaError(error)) {
                throw error;
              }
            }

            if (!allowed) {
              throw new APIError("UNAUTHORIZED", {
                code: "SESSION_ENDED",
                message: "Your session has ended. Sign in again.",
              });
            }
          }),
        },
        {
          // Single sign-on goes through the provider's sign-in page and back
          // to /callback/sso, where it is recorded. Better Auth would also
          // take an ID token posted straight to /sign-in/social; the app
          // never does that, so it is refused rather than left unaudited.
          matcher: (ctx) => ctx.path === "/sign-in/social",
          handler: createAuthMiddleware(async (ctx) => {
            if (
              typeof ctx.body === "object" &&
              ctx.body !== null &&
              "idToken" in ctx.body &&
              ctx.body.idToken
            ) {
              throw new APIError("BAD_REQUEST", {
                code: "ID_TOKEN_SIGN_IN_NOT_ALLOWED",
                message: "Sign in through your organization's sign-in page.",
              });
            }
          }),
        },
        {
          // A device that skips the second step would make "two-step
          // sign-in required" untrue, so devices are never trusted.
          matcher: (ctx) => SECOND_STEP_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (
              typeof ctx.body === "object" &&
              ctx.body !== null &&
              "trustDevice" in ctx.body &&
              ctx.body.trustDevice
            ) {
              throw new APIError("BAD_REQUEST", {
                code: "TRUST_DEVICE_NOT_ALLOWED",
                message:
                  "This install asks for the second step at every sign-in.",
              });
            }

            if (ctx.request) {
              const session = await getSessionFromCtx(ctx).catch(() => null);

              secondStepWithSession.set(ctx.request, session !== null);
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const email = readEmail(ctx.body);

            if (!email) {
              return;
            }

            const lock = await getSignInLockState(email);

            if (lock.locked) {
              throw new APIError("TOO_MANY_REQUESTS", {
                code: "SIGN_IN_LOCKED",
                message: SIGN_IN_LOCKED_MESSAGE,
              });
            }
          }),
        },
        {
          // An install that requires two-step sign-in does not let anyone
          // turn theirs off. An administrator can still reset it for
          // someone who lost their phone, and they set it up again.
          matcher: (ctx) => ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async () => {
            if ((await getSettings()).requireTwoFactor) {
              throw new APIError("FORBIDDEN", {
                code: "TWO_FACTOR_REQUIRED_BY_ADMINISTRATOR",
                message:
                  "Your organization requires two-step sign-in, so it cannot be turned off.",
              });
            }
          }),
        },
        {
          matcher: (ctx) => SESSION_FIRST_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.request) {
              return;
            }

            const session = await getSessionFromCtx(ctx).catch(() => null);

            if (session) {
              sessionActors.set(ctx.request, {
                email: session.user.email,
                userId: session.user.id,
              });
            }
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            isProviderCallback(ctx.path) ||
            ctx.path === "/sign-in/email" ||
            ctx.path === "/change-password" ||
            SECOND_STEP_PATHS.has(ctx.path ?? "") ||
            SESSION_FIRST_PATHS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const returned: unknown = ctx.context.returned;
            const failed = isAPIError(returned) || returned instanceof Error;
            const path = ctx.path ?? "";

            if (path === "/sign-in/email") {
              await afterPasswordSignIn(ctx, returned, failed);
              return;
            }

            if (isProviderCallback(path)) {
              await afterProviderSignIn(ctx, returned);
              return;
            }

            if (SECOND_STEP_PATHS.has(path)) {
              await afterSecondStep(
                ctx,
                returned,
                failed,
                ctx.request
                  ? secondStepWithSession.get(ctx.request)
                  : undefined,
              );
              return;
            }

            if (failed) {
              return;
            }

            if (path === "/change-password") {
              const user = readUser(returned);

              if (user) {
                await record(ctx, {
                  actorEmail: user.email,
                  actorUserId: user.id,
                  event: "password_changed",
                  targetUserId: user.id,
                });
              }

              return;
            }

            const actor = ctx.request
              ? sessionActors.get(ctx.request)
              : undefined;

            if (!actor) {
              return;
            }

            await record(ctx, {
              actorEmail: actor.email,
              actorUserId: actor.userId,
              event: SESSION_FIRST_EVENTS[path] ?? "signed_out",
              targetUserId: actor.userId,
            });
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}

async function afterPasswordSignIn(
  ctx: HookContext,
  returned: unknown,
  failed: boolean,
) {
  const email = readEmail(ctx.body);

  if (!email) {
    return;
  }

  if (failed) {
    const code = readFailureCode(returned);
    // The password was right; the address is not confirmed yet. Not a
    // guess, so it does not count towards the lockout.
    const wrongPassword = code !== "EMAIL_NOT_VERIFIED";
    const counted = wrongPassword ? await countFailedSignIn(email) : null;
    const userId = await findUserIdByEmail(email).catch(() => null);

    // Tries at addresses with no account are kept in the audit trail, which
    // is never cut, only up to a number an hour from each address they come
    // from. The rest are logged, so trying made-up addresses cannot grow
    // the trail without end.
    if (!userId && !(await mayRecordUnknownAddressFailure(ctx))) {
      logSecurityEvent("warn", {
        category: "sign_in_failed_unrecorded",
        ipAddress: requestDetails(ctx).ipAddress,
        message:
          "A sign-in to an address with no account failed; too many from this address this hour to record each one.",
        userId: null,
      });

      return;
    }

    await record(ctx, {
      actorEmail: email,
      actorUserId: userId,
      event: "sign_in_failed",
      metadata: {
        method: "password",
        reason: code,
        ...(counted ? { failuresInWindow: counted.failures } : {}),
      },
      targetUserId: userId,
    });

    if (counted?.justLocked) {
      await record(ctx, {
        actorEmail: email,
        actorUserId: userId,
        event: "sign_in_locked",
        metadata: { failuresInWindow: MAX_FAILED_SIGN_INS },
        targetUserId: userId,
      });
    }

    return;
  }

  // The password was right but a second step is still to come. The sign-in
  // is recorded when that step is done.
  if (
    typeof returned === "object" &&
    returned !== null &&
    "twoFactorRedirect" in returned
  ) {
    return;
  }

  const user = readUser(returned);

  await clearFailedSignIns(email);

  if (user) {
    await record(ctx, {
      actorEmail: user.email,
      actorUserId: user.id,
      event: "sign_in_succeeded",
      metadata: { method: "password" },
      targetUserId: user.id,
    });
  }
}

/** The identity provider sending someone back (auth/sso.ts). */
function isProviderCallback(path: string | undefined): boolean {
  return path === "/callback/:id" || (path?.startsWith("/callback/") ?? false);
}

/**
 * The callback ends in a redirect either way: on to the app with a new
 * session, or back to the sign-in page with ?error= saying why not.
 */
async function afterProviderSignIn(ctx: HookContext, returned: unknown) {
  const session = ctx.context.newSession;
  const provider =
    typeof ctx.params?.id === "string" ? ctx.params.id : "unknown";

  if (session) {
    await record(ctx, {
      actorEmail: session.user.email,
      actorUserId: session.user.id,
      event: "sign_in_succeeded",
      metadata: { method: "sso", provider },
      targetUserId: session.user.id,
    });
    return;
  }

  const location =
    isAPIError(returned) && returned.headers instanceof Headers
      ? returned.headers.get("location")
      : null;
  let reason: string | null = null;

  try {
    reason = location
      ? new URL(location, "http://local").searchParams.get("error")
      : null;
  } catch {
    reason = null;
  }

  // A redirect with no error is the hand-over to the provider, or a POST
  // turned into a GET: nothing happened yet.
  if (!reason) {
    return;
  }

  await record(ctx, {
    actorEmail: null,
    actorUserId: null,
    event: "sign_in_failed",
    metadata: { method: "sso", provider, reason },
    targetUserId: null,
  });
}

function hasSessionToken(returned: unknown): boolean {
  return (
    typeof returned === "object" &&
    returned !== null &&
    "token" in returned &&
    typeof returned.token === "string" &&
    returned.token.length > 0
  );
}

async function afterSecondStep(
  ctx: HookContext,
  returned: unknown,
  failed: boolean,
  withSession: boolean | undefined,
) {
  const challengeCookie = await ctx
    .getSignedCookie(
      ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME).name,
      ctx.context.secret,
    )
    .catch(() => null);
  const method =
    ctx.path === "/two-factor/verify-backup-code"
      ? "backup_code"
      : "authenticator";

  // A signed-in person confirming the authenticator they are setting up.
  // Better Auth treats any check made with a session that way, whatever
  // challenge cookie is left over from an earlier sign-in.
  if (withSession ?? !challengeCookie) {
    const user = readUser(returned);

    if (
      !failed &&
      ctx.path === "/two-factor/verify-totp" &&
      user &&
      typeof returned === "object" &&
      returned !== null &&
      "user" in returned &&
      (returned.user as { twoFactorEnabled?: unknown }).twoFactorEnabled ===
        false
    ) {
      await record(ctx, {
        actorEmail: user.email,
        actorUserId: user.id,
        event: "two_factor_enabled",
        targetUserId: user.id,
      });
    }

    return;
  }

  if (failed) {
    const pending = await ctx.context.internalAdapter
      .findVerificationValue(challengeCookie)
      .catch(() => null);
    const userId = pending?.value ?? null;
    const email = userId
      ? await queryOne<{ email: string }>(
          getDb(),
          `SELECT email FROM "user" WHERE id = $1`,
          [userId],
        )
          .then((row) => row?.email ?? null)
          .catch(() => null)
      : null;

    await record(ctx, {
      actorEmail: email,
      actorUserId: userId,
      event: "sign_in_failed",
      metadata: { method, reason: readFailureCode(returned) },
      targetUserId: userId,
    });

    return;
  }

  const user = readUser(returned);

  // A check made with disableSession issues no session, so it is not a
  // finished sign-in.
  if (!user || !hasSessionToken(returned)) {
    return;
  }

  await clearFailedSignIns(user.email);
  await record(ctx, {
    actorEmail: user.email,
    actorUserId: user.id,
    event: "sign_in_succeeded",
    metadata: { method: "password", secondStep: method },
    targetUserId: user.id,
  });
}
