import {
  authenticateApiKey,
  readBearerToken,
  scopeAllows,
  type ApiKeyPrincipal,
  type ApiKeyScope,
} from "../api-keys.ts";
import { apiError } from "../api/http.ts";
import { logSecurityEvent } from "../security/logging.ts";
import { consumeRateLimit, peekRateLimit } from "../security/rate-limit.ts";
import { getClientIpAddress, getRequestPathname } from "../security/request.ts";

/** Requests one key may make in a window, across every endpoint. */
export const API_KEY_RATE_LIMIT = 600;
export const API_KEY_RATE_WINDOW_MS = 10 * 60 * 1000;
/** Bad keys one address may send before more of them get 429. */
const FAILED_ATTEMPT_LIMIT = 30;
const FAILED_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

const UNAUTHORIZED_MESSAGE =
  'Send a valid API key as "Authorization: Bearer sdk_…".';

/**
 * For /api/v1 routes: the key's principal, or the response to send. Every
 * kind of bad key gets the same 401, so a caller cannot tell an unknown key
 * from a revoked one. Rate limit headers are set on the response by
 * `withRateLimitHeaders`.
 */
export async function requireApiKey(
  request: Request,
  scope: ApiKeyScope,
): Promise<(ApiKeyPrincipal & { rateLimit: RateLimitState }) | Response> {
  const ipAddress = getClientIpAddress(request.headers);
  const presented = readBearerToken(request.headers);

  if (!presented) {
    return apiError(401, "unauthorized", UNAUTHORIZED_MESSAGE, {
      "www-authenticate": 'Bearer realm="signudoc"',
    });
  }

  // The key is looked up first, so bad keys from an address never turn
  // away a good one from it: another worker of an app still sending a key
  // that was revoked, or, off Vercel, a stranger who forged the address in
  // X-Forwarded-For to lock an integration out.
  const principal = await authenticateApiKey(presented);

  if (!principal) {
    return refuseBadKey(request, ipAddress);
  }

  const decision = await consumeRateLimit({
    key: `api-key:${principal.apiKey.id}`,
    limit: API_KEY_RATE_LIMIT,
    windowMs: API_KEY_RATE_WINDOW_MS,
  });
  const rateLimit: RateLimitState = {
    limit: API_KEY_RATE_LIMIT,
    remaining: Math.max(0, API_KEY_RATE_LIMIT - decision.count),
    resetSeconds: decision.retryAfterSeconds,
  };

  if (!decision.allowed) {
    logSecurityEvent("warn", {
      category: "api_key_rate_limited",
      ipAddress,
      message: "Rate limit exceeded for an API key.",
      metadata: { apiKeyId: principal.apiKey.id },
      path: getRequestPathname(request),
      userId: principal.user.id,
    });

    return withRateLimitHeaders(
      apiError(
        429,
        "rate_limited",
        "This key has made too many requests. Wait and try again.",
        { "retry-after": String(decision.retryAfterSeconds) },
      ),
      rateLimit,
    );
  }

  if (!scopeAllows(principal.apiKey.scope, scope)) {
    return withRateLimitHeaders(
      apiError(
        403,
        "forbidden",
        "This key is read-only. Use a key with write access.",
      ),
      rateLimit,
    );
  }

  return { ...principal, rateLimit };
}

/**
 * The answer to a key that does not work. Bad keys are counted per
 * address. Once an address has sent too many, it gets 429 instead of 401
 * until the window ends, and nothing more is written or logged for it.
 */
async function refuseBadKey(
  request: Request,
  ipAddress: string | null,
): Promise<Response> {
  const failureKey = `api-key-failures:${ipAddress ?? "unknown"}`;
  const failures = await peekRateLimit({
    key: failureKey,
    limit: FAILED_ATTEMPT_LIMIT,
  });

  if (!failures.allowed) {
    return apiError(
      429,
      "rate_limited",
      "Too many requests with a bad key. Try again later.",
      { "retry-after": String(failures.retryAfterSeconds) },
    );
  }

  const counted = await consumeRateLimit({
    key: failureKey,
    limit: FAILED_ATTEMPT_LIMIT,
    windowMs: FAILED_ATTEMPT_WINDOW_MS,
  });

  // Bad keys sent at the same moment can all pass the check above, so the
  // count they leave decides too.
  if (!counted.allowed) {
    return apiError(
      429,
      "rate_limited",
      "Too many requests with a bad key. Try again later.",
      { "retry-after": String(counted.retryAfterSeconds) },
    );
  }

  logSecurityEvent("warn", {
    category: "api_key_rejected",
    ipAddress,
    message: "Refused an API request with an unknown, revoked or expired key.",
    path: getRequestPathname(request),
  });

  return apiError(401, "unauthorized", UNAUTHORIZED_MESSAGE, {
    "www-authenticate": 'Bearer realm="signudoc", error="invalid_token"',
  });
}

export type RateLimitState = {
  limit: number;
  remaining: number;
  resetSeconds: number;
};

export function withRateLimitHeaders<T extends Response>(
  response: T,
  state: RateLimitState,
): T {
  response.headers.set("ratelimit-limit", String(state.limit));
  response.headers.set("ratelimit-remaining", String(state.remaining));
  response.headers.set("ratelimit-reset", String(state.resetSeconds));
  return response;
}
