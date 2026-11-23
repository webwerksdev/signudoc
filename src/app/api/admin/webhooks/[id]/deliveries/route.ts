import { NextResponse } from "next/server";

import { listEndpointDeliveries } from "@/lib/webhooks/log";
import { handleWebhookAdmin, noStore } from "@/lib/webhooks/admin-route";

type RouteContext = { params: Promise<{ id: string }> };

// The last 100 deliveries to one endpoint, newest first.
export function GET(request: Request, context: RouteContext) {
  return handleWebhookAdmin(request, "webhook_log_failure", async () => {
    const { id } = await context.params;

    return NextResponse.json(
      { deliveries: await listEndpointDeliveries(id) },
      { headers: noStore },
    );
  });
}
