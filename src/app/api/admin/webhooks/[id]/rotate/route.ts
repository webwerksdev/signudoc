import { NextResponse } from "next/server";

import { rotateWebhookSecret } from "@/lib/webhooks/endpoints";
import { handleWebhookAdmin, noStore } from "@/lib/webhooks/admin-route";

type RouteContext = { params: Promise<{ id: string }> };

// A new signing secret, shown once. The old one keeps signing for a day.
export function POST(request: Request, context: RouteContext) {
  return handleWebhookAdmin(
    request,
    "webhook_rotate_failure",
    async (actor) => {
      const { id } = await context.params;

      return NextResponse.json(await rotateWebhookSecret(actor, id), {
        headers: noStore,
      });
    },
  );
}
