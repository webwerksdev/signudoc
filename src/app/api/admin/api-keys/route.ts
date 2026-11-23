import { NextResponse } from "next/server";

import {
  ApiKeyError,
  createApiKey,
  listApiKeys,
  parseApiKeyExpiry,
  parseApiKeyName,
  parseApiKeyScope,
} from "@/lib/api-keys";
import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";
import { getSettings } from "@/lib/settings";

const noStore = { "cache-control": "private, no-store" };

// API keys for the public API. Administrators only. The key itself is in
// the response to the request that creates it, and nowhere else, ever.

export async function GET(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  return NextResponse.json({ keys: await listApiKeys() }, { headers: noStore });
}

export async function POST(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "api_key_create",
    key: buildRateLimitKey(["api-key-create", session.user.id]),
    limit: 10,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  if ((await getSettings()).hosted) {
    return NextResponse.json(
      { error: "API keys are for self-hosted installs." },
      { headers: noStore, status: 400 },
    );
  }

  const parsed: unknown = await request.json().catch(() => null);
  const body =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { expiresInDays?: unknown; name?: unknown; scope?: unknown })
      : {};
  const name = parseApiKeyName(body.name);
  const scope = parseApiKeyScope(body.scope);
  const expiresInDays = parseApiKeyExpiry(body.expiresInDays);

  if (!name || !scope || expiresInDays === undefined) {
    return NextResponse.json(
      {
        error:
          "Give the key a name of up to 80 characters, read or write access, and an expiry of 30, 90 or 365 days or none.",
      },
      { headers: noStore, status: 400 },
    );
  }

  try {
    const created = await createApiKey(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      { expiresInDays, name, scope },
    );

    return NextResponse.json(created, { headers: noStore, status: 201 });
  } catch (error) {
    if (error instanceof ApiKeyError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "api_key_create_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while creating an API key.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The key could not be created." },
      { headers: noStore, status: 500 },
    );
  }
}
