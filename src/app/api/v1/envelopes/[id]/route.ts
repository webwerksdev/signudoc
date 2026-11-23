import { apiError, apiJson } from "@/lib/api/http";
import { getApiEnvelope } from "@/lib/api/envelopes";
import { handleApi } from "@/lib/api/route";
import { deleteDraftEnvelope } from "@/lib/envelopes";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApi(
    request,
    "read",
    "api_envelope_read_failure",
    async ({ actor }) => {
      const envelope = await getApiEnvelope(actor.userId, id);

      return envelope
        ? apiJson(envelope)
        : apiError(404, "not_found", "Envelope not found.");
    },
  );
}

// Deletes a draft. A sent envelope is voided instead, and kept.
export async function DELETE(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApi(
    request,
    "write",
    "api_envelope_delete_failure",
    async ({ actor }) => {
      const envelope = await getApiEnvelope(actor.userId, id);

      if (!envelope) {
        return apiError(404, "not_found", "Envelope not found.");
      }

      if (envelope.status !== "draft") {
        return apiError(
          409,
          "wrong_state",
          "Only a draft can be deleted. Void a sent envelope instead.",
        );
      }

      await deleteDraftEnvelope(actor.userId, id);

      return apiJson({ deleted: true, id, object: "envelope" });
    },
  );
}
