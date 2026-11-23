import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db/connection";
import {
  cancelEnvelopeDeletion,
  scheduleEnvelopeDeletion,
} from "@/lib/envelope-deletion";
import { EnvelopeMutationError } from "@/lib/envelopes";
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

// A finished envelope's scheduled deletion. POST schedules it, DELETE
// cancels it; only an administrator may do either. Drafts are deleted with
// DELETE on the envelope itself.

type EnvelopeDeletionRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

async function handle(
  request: Request,
  context: EnvelopeDeletionRouteContext,
  action: "cancel" | "schedule",
) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const { id } = await context.params;
  const ipAddress = getClientIpAddress(request.headers);
  const rateLimitResponse = await applyRateLimit({
    category: "finished_envelope_delete",
    key: buildRateLimitKey(["envelope-delete", session.user.id]),
    limit: 60,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  const actor = { email: session.user.email, userId: session.user.id };
  const userAgent = getRequestUserAgent(request.headers);

  try {
    if (action === "cancel") {
      const result = await cancelEnvelopeDeletion(
        id,
        { actor, ipAddress, userAgent },
        { database: getDb() },
      );

      return NextResponse.json(result, { headers: NO_STORE, status: 200 });
    }

    const body = (await request.json().catch(() => null)) as {
      reason?: unknown;
    } | null;
    const result = await scheduleEnvelopeDeletion(
      id,
      { actor, ipAddress, reason: body?.reason ?? null, userAgent },
      { database: getDb() },
    );

    return NextResponse.json(
      { deleteAfter: result.deleteAfter, envelopeId: id },
      { headers: NO_STORE, status: 200 },
    );
  } catch (error) {
    if (error instanceof EnvelopeMutationError) {
      return NextResponse.json(
        { error: error.message },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "finished_envelope_delete_failure",
      ipAddress,
      message:
        action === "cancel"
          ? "Unexpected failure while cancelling an envelope's deletion."
          : "Unexpected failure while scheduling an envelope's deletion.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      {
        error:
          action === "cancel"
            ? "Unable to cancel this deletion."
            : "Unable to schedule this envelope's deletion.",
      },
      { headers: NO_STORE, status: 500 },
    );
  }
}

export function POST(request: Request, context: EnvelopeDeletionRouteContext) {
  return handle(request, context, "schedule");
}

export function DELETE(
  request: Request,
  context: EnvelopeDeletionRouteContext,
) {
  return handle(request, context, "cancel");
}
