import { headers } from "next/headers";

import { SigningShell } from "@/components/signing/signing-shell";
import { getDb } from "@/lib/db/connection";
import { isEmbedOriginAllowed, openEmbedLink } from "@/lib/embedding";
import { parseEmbedOrigin } from "@/lib/embed-origin";
import { getClientIpAddress } from "@/lib/security/request";
import {
  SigningAccessError,
  SigningVerificationRequiredError,
  getSigningPayloadForToken,
} from "@/lib/signing";

// The signing page, shown in a frame inside another app (see
// src/lib/embedding.ts). proxy.ts lets only the ?origin= site frame it;
// this page opens only when that is the site the link was made for.
// Embedded signers have no extra checks, so no cookie is needed: browsers
// do not send this site's cookies inside another site's frame.

type EmbedSignPageProps = {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ origin?: string | string[] }>;
};

export default async function EmbedSignPage({
  params,
  searchParams,
}: EmbedSignPageProps) {
  const { token } = await params;
  const { origin: originParam } = await searchParams;
  const origin = parseEmbedOrigin(
    Array.isArray(originParam) ? originParam[0] : originParam,
  );
  const database = getDb();
  const opened = await openEmbedLink(token, origin, database).catch(
    () => ({ ok: false, reason: "unknown" }) as const,
  );

  if (!opened.ok) {
    // Only an allowed site is told why; anything else learns nothing.
    const tellOrigin =
      origin &&
      opened.reason === "unknown" &&
      (await isEmbedOriginAllowed(origin, database).catch(() => false))
        ? origin
        : null;

    return (
      <SigningShell
        embedOrigin={tellOrigin}
        initialState={opened.reason === "unknown" ? "expired" : "error"}
        key={token}
        token={token}
      />
    );
  }

  let initialState:
    | "already-signed"
    | "completed"
    | "declined"
    | "error"
    | "expired"
    | "voided"
    | undefined;
  let record: Awaited<ReturnType<typeof getSigningPayloadForToken>> | null =
    null;

  try {
    const requestHeaders = await headers();

    record = await getSigningPayloadForToken(token, {
      database,
      requestMeta: {
        ipAddress: getClientIpAddress(requestHeaders),
        userAgent: requestHeaders.get("user-agent")?.trim() ?? null,
      },
    });
  } catch (error) {
    if (error instanceof SigningAccessError) {
      initialState = error.state;
    } else if (error instanceof SigningVerificationRequiredError) {
      // Embedded envelopes are sent without extra checks.
      initialState = "error";
    } else {
      initialState = "error";
    }
  }

  return (
    <SigningShell
      embedOrigin={origin}
      initialState={initialState}
      key={token}
      record={record ?? undefined}
      token={token}
    />
  );
}
