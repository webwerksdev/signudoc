import { NextResponse } from "next/server";

import { logSecurityEvent } from "./logging.ts";
import { consumeRateLimit } from "./rate-limit.ts";
import { getClientIpAddress, getRequestPathname } from "./request.ts";

type RateLimitInput = {
  category: string;
  key: string;
  limit: number;
  message?: string;
  request: Request;
  userId?: string | null;
  windowMs: number;
};

/**
 * Counts this request against a limit. Returns the 429 response to send when
 * it is over, or null when the request may go ahead.
 */
export async function applyRateLimit(
  input: RateLimitInput,
): Promise<NextResponse | null> {
  const decision = await consumeRateLimit({
    key: input.key,
    limit: input.limit,
    windowMs: input.windowMs,
  });

  if (decision.allowed) {
    return null;
  }

  logSecurityEvent("warn", {
    category: input.category,
    ipAddress: getClientIpAddress(input.request.headers),
    message: "Rate limit exceeded.",
    path: getRequestPathname(input.request),
    userId: input.userId ?? null,
  });

  return NextResponse.json(
    {
      error: input.message ?? "Too many requests. Please try again soon.",
    },
    {
      headers: { "retry-after": String(decision.retryAfterSeconds) },
      status: 429,
    },
  );
}

// Every public link route (signing, downloads) is limited per link, and each
// made-up link would start a count of its own. So one address also gets a
// fixed number of link requests in all, whatever links it asks for.
const PUBLIC_LINK_REQUESTS_PER_ADDRESS = 1000;
const PUBLIC_LINK_WINDOW_MS = 10 * 60 * 1000;

/**
 * For a route opened by a link's token: counts the request against the
 * address's limit for all public links first, then against the route's own.
 */
export async function applyPublicLinkRateLimit(
  input: RateLimitInput,
): Promise<NextResponse | null> {
  return (
    (await applyRateLimit({
      category: "public_link_address",
      key: buildRateLimitKey([
        "public-link",
        getClientIpAddress(input.request.headers) ?? "unknown",
      ]),
      limit: PUBLIC_LINK_REQUESTS_PER_ADDRESS,
      request: input.request,
      windowMs: PUBLIC_LINK_WINDOW_MS,
    })) ?? (await applyRateLimit(input))
  );
}

export function buildRateLimitKey(parts: Array<string | null | undefined>) {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(":");
}
