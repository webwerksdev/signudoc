import { NextResponse } from "next/server";

import { ApiKeyError, revokeApiKey } from "@/lib/api-keys";
import { requireAdminSession } from "@/lib/auth/admin";
import { logRouteError } from "@/lib/security/logging";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";

const noStore = { "cache-control": "private, no-store" };

type ApiKeyRouteContext = {
  params: Promise<{ id: string }>;
};

// Revokes an API key. It stops working at once and cannot be turned back
// on. Administrators only.
export async function DELETE(request: Request, context: ApiKeyRouteContext) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;

  try {
    const key = await revokeApiKey(
      {
        email: session.user.email,
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
        userId: session.user.id,
      },
      id,
    );

    return NextResponse.json({ key }, { headers: noStore });
  } catch (error) {
    if (error instanceof ApiKeyError) {
      return NextResponse.json(
        { error: error.message },
        { headers: noStore, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "api_key_revoke_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while revoking an API key.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The key could not be revoked." },
      { headers: noStore, status: 500 },
    );
  }
}
