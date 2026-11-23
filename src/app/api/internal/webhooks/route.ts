import { NextResponse } from "next/server";

import { identifyRetentionCaller } from "@/lib/retention-job";
import { logRouteError } from "@/lib/security/logging";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { drainWebhookDeliveries } from "@/lib/webhooks/deliver";

// Sends webhook deliveries that are due for another try. Vercel's cron
// calls this once a day (see vercel.json), which is as often as Hobby
// allows; on Pro it can be every few minutes. Most tries never wait for
// it: they go out right after the change, or with the next request.
//
// It takes the same secret as the cleanup job. With none configured, an
// anonymous caller may run it once a minute and learns nothing: it only
// sends what was due anyway.

async function handle(request: Request) {
  const caller = identifyRetentionCaller(request.headers.get("authorization"));

  if (caller === "denied") {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    if (caller === "anonymous") {
      const ration = await consumeRateLimit({
        key: "job:webhooks",
        limit: 1,
        windowMs: 60 * 1000,
      });

      if (!ration.allowed) {
        return new NextResponse(null, { status: 204 });
      }
    }

    const summary = await drainWebhookDeliveries({ maxBatches: 8 });

    return caller === "authorized"
      ? NextResponse.json(summary)
      : new NextResponse(null, { status: 204 });
  } catch (error) {
    logRouteError(error, {
      category: "webhook_drain_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Sending webhook deliveries failed.",
      path: getRequestPathname(request),
    });

    return new NextResponse(null, { status: 500 });
  }
}

export function GET(request: Request) {
  return handle(request);
}

export function POST(request: Request) {
  return handle(request);
}
