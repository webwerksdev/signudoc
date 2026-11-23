import { NextResponse } from "next/server";

import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  createWebhookEndpoint,
  listWebhookEndpoints,
  parseWebhookDescription,
} from "@/lib/webhooks/endpoints";
import {
  parseWebhookEventTypes,
  webhookEventTypes,
} from "@/lib/webhooks/events";
import {
  handleWebhookAdmin,
  noStore,
  notAJsonObject,
  readJsonObject,
} from "@/lib/webhooks/admin-route";

// Webhook endpoints for the whole install. Administrators only. The signing
// secret is in the response that creates an endpoint, and nowhere else.

export function GET(request: Request) {
  return handleWebhookAdmin(request, "webhook_list_failure", async () =>
    NextResponse.json(
      {
        endpoints: await listWebhookEndpoints(),
        eventTypes: webhookEventTypes,
      },
      { headers: noStore },
    ),
  );
}

export function POST(request: Request) {
  return handleWebhookAdmin(
    request,
    "webhook_create_failure",
    async (actor) => {
      const limited = await applyRateLimit({
        category: "webhook_create",
        key: buildRateLimitKey(["webhook-create", actor.userId]),
        limit: 10,
        request,
        userId: actor.userId,
        windowMs: 10 * 60 * 1000,
      });

      if (limited) {
        return limited;
      }

      const body = await readJsonObject(request);

      if (!body) {
        return notAJsonObject();
      }

      const events = parseWebhookEventTypes(body.events);
      const description = parseWebhookDescription(body.description);

      if (!events || description === null) {
        return NextResponse.json(
          {
            error:
              "Choose at least one event, and keep the description to 200 characters.",
          },
          { headers: noStore, status: 400 },
        );
      }

      const created = await createWebhookEndpoint(actor, {
        description,
        events,
        url: body.url,
      });

      return NextResponse.json(created, { headers: noStore, status: 201 });
    },
  );
}
