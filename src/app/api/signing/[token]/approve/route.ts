import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getDb } from "@/lib/db/connection";
import {
  verificationRequiredResponse,
  verifiedMethodsForRequest,
} from "@/lib/signing-route";
import {
  approveSigningForToken,
  SigningAccessError,
  SigningMutationError,
  SigningVerificationRequiredError,
} from "@/lib/signing";
import { logRouteError } from "@/lib/security/logging";
import {
  applyPublicLinkRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestUserAgent,
} from "@/lib/security/request";
import { readLimitedBody } from "@/lib/utils/limited-body";

// An approver approves the document. Rejecting goes through the decline
// route, which records a rejection for an approver (signing.ts). The same
// checks, consent and limits apply as to a signature.

type ApproveRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

/** An approval is one small number; nothing needs more than this. */
const MAX_APPROVAL_BODY_BYTES = 4 * 1024;

/** The JSON body, or null when it is too large or not JSON. */
async function readApprovalBody(request: Request): Promise<unknown> {
  const body = await readLimitedBody(request, MAX_APPROVAL_BODY_BYTES).catch(
    () => null,
  );

  if (!body) {
    return null;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    return null;
  }
}

export async function POST(request: Request, context: ApproveRouteContext) {
  const { token } = await context.params;
  const rateLimitResponse = await applyPublicLinkRateLimit({
    category: "signing_submit",
    key: buildRateLimitKey([
      "signing-submit",
      token,
      getClientIpAddress(request.headers) ?? "unknown",
    ]),
    limit: 10,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const body = await readApprovalBody(request);

  try {
    const payload = await approveSigningForToken(token, body, {
      database: getDb(),
      requestMeta: {
        ipAddress: getClientIpAddress(request.headers),
        userAgent: getRequestUserAgent(request.headers),
      },
      verifiedMethods: verifiedMethodsForRequest(token, request),
    });

    return NextResponse.json(payload, { headers: NO_STORE, status: 200 });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? "Invalid approval." },
        { headers: NO_STORE, status: 400 },
      );
    }

    if (error instanceof SigningVerificationRequiredError) {
      return verificationRequiredResponse(error);
    }

    if (error instanceof SigningAccessError) {
      return NextResponse.json(
        { error: error.message, state: error.state },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    if (error instanceof SigningMutationError) {
      return NextResponse.json(
        { error: error.message },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "signing_submit_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while approving a document.",
      path: request.url,
    });

    return NextResponse.json(
      { error: "Unable to record the approval." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
