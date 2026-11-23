import { apiError, apiJson } from "@/lib/api/http";
import { listApiEnvelopeEvents } from "@/lib/api/envelopes";
import { handleApi } from "@/lib/api/route";

type Context = { params: Promise<{ id: string }> };

// The envelope's audit trail, oldest first.
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApi(
    request,
    "read",
    "api_envelope_events_failure",
    async ({ actor }) => {
      const events = await listApiEnvelopeEvents(actor.userId, id);

      return events
        ? apiJson({ data: events, object: "list" })
        : apiError(404, "not_found", "Envelope not found.");
    },
  );
}
