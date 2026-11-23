import { NextResponse } from "next/server";

import { requireAdminSession } from "../auth/admin.ts";
import { logRouteError } from "../security/logging.ts";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "../security/request.ts";
import { getSettings } from "../settings.ts";
import { WebhookEndpointError, type WebhookActor } from "./endpoints.ts";

// What every /api/admin/webhooks route shares: administrators only, not on
// a hosted install, never cached, and known errors become plain messages.
// The embedded signing settings use it too, with their own words.

export const noStore = { "cache-control": "private, no-store" };

/** What a feature's settings routes say when they cannot run. */
export type AdminRouteWords = {
  /** Logged with an unexpected failure. */
  failure: string;
  /** The answer on a hosted install. */
  hosted: string;
};

const WEBHOOK_WORDS: AdminRouteWords = {
  failure: "Unexpected failure in a webhook settings request.",
  hosted: "Webhooks are for self-hosted installs.",
};

export async function handleWebhookAdmin(
  request: Request,
  category: string,
  run: (actor: WebhookActor) => Promise<Response>,
  words: AdminRouteWords = WEBHOOK_WORDS,
): Promise<Response> {
  const ipAddress = getClientIpAddress(request.headers);
  // Known once the session is checked; a failure before that (the
  // database is down) is logged and answered the same way, just without it.
  let userId: string | null = null;

  try {
    const sessionResult = await requireAdminSession(request);

    if (sessionResult instanceof Response) {
      // A refusal is not cached either.
      sessionResult.headers.set("cache-control", noStore["cache-control"]);
      return sessionResult;
    }

    userId = sessionResult.user.id;

    if ((await getSettings()).hosted) {
      return NextResponse.json(
        { error: words.hosted },
        { headers: noStore, status: 400 },
      );
    }

    const response = await run({
      email: sessionResult.user.email,
      ipAddress,
      userAgent: getRequestUserAgent(request.headers),
      userId: sessionResult.user.id,
    });

    // Whatever the route answered, a refusal of its own included.
    response.headers.set("cache-control", noStore["cache-control"]);
    return response;
  } catch (error) {
    if (error instanceof WebhookEndpointError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category,
      ipAddress: ipAddress ?? null,
      message: words.failure,
      path: getRequestPathname(request),
      userId,
    });

    return NextResponse.json(
      { error: "Something went wrong. Try again." },
      { headers: noStore, status: 500 },
    );
  }
}

/**
 * The JSON object in a request body, or null when the body is not one
 * (missing, cut off, or a list), so a route can refuse it instead of
 * treating it as a request to change nothing.
 */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await request.json().catch(() => null);

  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** The answer to a body readJsonObject could not read. */
export function notAJsonObject(): Response {
  return NextResponse.json(
    { error: "Send the request as a JSON object." },
    { headers: noStore, status: 400 },
  );
}
