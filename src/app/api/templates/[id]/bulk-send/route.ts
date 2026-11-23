import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { requireVerifiedSenderSession } from "@/lib/auth/route-session";
import { BulkSendError, bulkSendFromTemplate } from "@/lib/bulk-send";
import { getDb } from "@/lib/db/connection";
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
import { DocumentImportError } from "@/lib/services/document-import";
import { TemplateError } from "@/lib/templates";
import { readLimitedBody } from "@/lib/utils/limited-body";

type BulkSendRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

const MAX_BULK_SEND_BODY_BYTES = 1024 * 1024;

// Preview or send a template to many people from a CSV.

export async function POST(request: Request, context: BulkSendRouteContext) {
  const sessionResult = await requireVerifiedSenderSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const ipAddress = getClientIpAddress(request.headers);
  const bodyBytes = await readLimitedBody(request, MAX_BULK_SEND_BODY_BYTES);

  if (bodyBytes === null) {
    return NextResponse.json(
      { error: "This CSV is too large to send in one batch." },
      { status: 413 },
    );
  }

  let body: { confirm?: unknown } | null = null;

  try {
    body = JSON.parse(new TextDecoder().decode(bodyBytes)) as {
      confirm?: unknown;
    };
  } catch {
    return NextResponse.json(
      { error: "This request was not valid JSON." },
      { status: 400 },
    );
  }

  const confirm = body?.confirm === true;
  const rateLimitResponse = await applyRateLimit({
    category: confirm ? "template_bulk_send" : "template_bulk_send_preview",
    key: buildRateLimitKey([
      confirm ? "bulk-send" : "bulk-send-preview",
      session.user.id,
    ]),
    limit: confirm ? 10 : 30,
    request,
    userId: session.user.id,
    windowMs: confirm ? 60 * 60 * 1000 : 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    rateLimitResponse.headers.set("cache-control", "private, no-store");
    return rateLimitResponse;
  }

  const { id } = await context.params;

  try {
    const result = await bulkSendFromTemplate(session.user.id, id, body, {
      database: getDb(),
      sender: {
        email: session.user.email,
        ipAddress,
        name:
          typeof session.user.name === "string" && session.user.name.trim()
            ? session.user.name
            : session.user.email,
        userAgent: getRequestUserAgent(request.headers),
      },
    });

    return NextResponse.json(result, {
      headers: { "cache-control": "private, no-store" },
      status: 200,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid bulk send request." },
        { status: 400 },
      );
    }

    if (
      error instanceof BulkSendError ||
      error instanceof TemplateError ||
      error instanceof EnvelopeMutationError
    ) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode },
      );
    }

    if (error instanceof DocumentImportError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    logRouteError(error, {
      category: "template_bulk_send_failure",
      ipAddress,
      message: "Unexpected failure while sending a template to many people.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "Unable to send this template to many people." },
      { status: 500 },
    );
  }
}
