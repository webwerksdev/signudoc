import { NextResponse } from "next/server";

import { scheduleWebhookDrain } from "@/lib/webhooks/deliver";
import { resendWebhookDelivery } from "@/lib/webhooks/log";
import { handleWebhookAdmin, noStore } from "@/lib/webhooks/admin-route";

type RouteContext = { params: Promise<{ id: string }> };

// "Send again": the delivery goes back in line with a full set of tries,
// and is sent right after this response.
export function POST(request: Request, context: RouteContext) {
  return handleWebhookAdmin(request, "webhook_resend_failure", async () => {
    const { id } = await context.params;

    if (!(await resendWebhookDelivery(id))) {
      return NextResponse.json(
        { error: "That delivery does not exist, or is being sent right now." },
        { headers: noStore, status: 409 },
      );
    }

    scheduleWebhookDrain();

    return NextResponse.json({ queued: true }, { headers: noStore });
  });
}
