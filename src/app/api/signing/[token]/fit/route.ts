import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { getDb } from "@/lib/db/connection";
import { logRouteError } from "@/lib/security/logging";
import {
  applyPublicLinkRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress } from "@/lib/security/request";
import {
  checkSigningFieldFit,
  SigningAccessError,
  SigningMutationError,
  SigningVerificationRequiredError,
} from "@/lib/signing";
import {
  verificationRequiredResponse,
  verifiedMethodsForRequest,
} from "@/lib/signing-route";

type FitRouteContext = {
  params: Promise<{
    token: string;
  }>;
};

const NO_STORE = { "cache-control": "private, no-store" };

export async function POST(request: Request, context: FitRouteContext) {
  const { token } = await context.params;
  const rateLimitResponse = await applyPublicLinkRateLimit({
    category: "signing_field_fit",
    // Per link, from wherever it is asked: each check measures the text
    // with the document's fonts, so a link gets a fixed amount of that
    // work however many addresses ask.
    key: buildRateLimitKey(["signing-field-fit", token]),
    // Asked as the signer types, after each pause.
    limit: 200,
    request,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  try {
    return NextResponse.json(
      await checkSigningFieldFit(
        token,
        await request.json().catch(() => null),
        {
          database: getDb(),
          verifiedMethods: verifiedMethodsForRequest(token, request),
        },
      ),
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { error: "Invalid request." },
        { headers: NO_STORE, status: 400 },
      );
    }

    if (error instanceof SigningVerificationRequiredError) {
      return verificationRequiredResponse(error);
    }

    if (error instanceof SigningMutationError) {
      return NextResponse.json(
        { error: error.message },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    if (error instanceof SigningAccessError) {
      return NextResponse.json(
        { error: error.message, state: error.state },
        { headers: NO_STORE, status: error.statusCode },
      );
    }

    logRouteError(error, {
      category: "signing_field_fit_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while checking an answer fits its box.",
      path: request.url,
    });

    return NextResponse.json(
      { error: "The answer could not be checked right now." },
      { headers: NO_STORE, status: 500 },
    );
  }
}
