import { NextResponse } from "next/server";

import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { sendTestWebhook } from "@/lib/webhooks/deliver";
import { getWebhookEndpoint } from "@/lib/webhooks/endpoints";
import { handleWebhookAdmin, noStore } from "@/lib/webhooks/admin-route";

type RouteContext = { params: Promise<{ id: string }> };

// Sends one webhook.test event now and says how the endpoint answered.
export function POST(request: Request, context: RouteContext) {
  return handleWebhookAdmin(request, "webhook_test_failure", async (actor) => {
    const limited = await applyRateLimit({
      category: "webhook_test",
      key: buildRateLimitKey(["webhook-test", actor.userId]),
      limit: 20,
      request,
      userId: actor.userId,
      windowMs: 10 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }

    const { id } = await context.params;
    const endpoint = await getWebhookEndpoint(id);

    if (!endpoint) {
      return NextResponse.json(
        { error: "That endpoint does not exist." },
        { headers: noStore, status: 404 },
      );
    }

    if (!endpoint.enabled) {
      return NextResponse.json(
        { error: "Turn the endpoint on first." },
        { headers: noStore, status: 409 },
      );
    }

    return NextResponse.json(
      { delivery: await sendTestWebhook(id) },
      { headers: noStore },
    );
  });
}
