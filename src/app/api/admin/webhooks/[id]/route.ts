import { NextResponse } from "next/server";

import {
  deleteWebhookEndpoint,
  parseWebhookDescription,
  updateWebhookEndpoint,
} from "@/lib/webhooks/endpoints";
import { parseWebhookEventTypes } from "@/lib/webhooks/events";
import {
  handleWebhookAdmin,
  noStore,
  notAJsonObject,
  readJsonObject,
} from "@/lib/webhooks/admin-route";

type RouteContext = { params: Promise<{ id: string }> };

// Changes or removes one webhook endpoint. Administrators only.

export function PATCH(request: Request, context: RouteContext) {
  return handleWebhookAdmin(
    request,
    "webhook_update_failure",
    async (actor) => {
      const { id } = await context.params;
      const body = await readJsonObject(request);

      if (!body) {
        return notAJsonObject();
      }

      const events =
        body.events === undefined
          ? undefined
          : parseWebhookEventTypes(body.events);
      const description =
        body.description === undefined
          ? undefined
          : parseWebhookDescription(body.description);

      if (
        events === null ||
        description === null ||
        (body.enabled !== undefined && typeof body.enabled !== "boolean")
      ) {
        return NextResponse.json(
          {
            error:
              "Choose at least one event, keep the description to 200 characters, and set enabled to true or false.",
          },
          { headers: noStore, status: 400 },
        );
      }

      const endpoint = await updateWebhookEndpoint(actor, id, {
        description,
        enabled: body.enabled as boolean | undefined,
        events,
        url: body.url,
      });

      return NextResponse.json({ endpoint }, { headers: noStore });
    },
  );
}

export function DELETE(request: Request, context: RouteContext) {
  return handleWebhookAdmin(
    request,
    "webhook_delete_failure",
    async (actor) => {
      const { id } = await context.params;

      await deleteWebhookEndpoint(actor, id);

      return NextResponse.json({ deleted: true }, { headers: noStore });
    },
  );
}
