import { z } from "zod";

import { MAX_JSON_BODY_BYTES, readBodyWithin } from "@/lib/api/body";
import { apiError, bodyTooLarge } from "@/lib/api/http";
import {
  apiSendOptionsSchema,
  describeZodError,
  getApiEnvelope,
  markEnvelopeAsApiMade,
  MAX_API_METADATA_BYTES,
  sendEnvelopeForApi,
} from "@/lib/api/envelopes";
import {
  API_CREATE_LIMIT,
  API_SEND_LIMIT,
  handleApi,
  runIdempotently,
} from "@/lib/api/route";
import { deleteDraftEnvelope } from "@/lib/envelopes";
import { createDraftFromTemplate } from "@/lib/templates";
import { signatureMeanings } from "@/lib/types/domain";

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  metadata: z
    .record(z.string(), z.unknown())
    .refine(
      (value) =>
        Buffer.byteLength(JSON.stringify(value), "utf8") <=
        MAX_API_METADATA_BYTES,
      { message: "Metadata must be at most 2048 bytes of JSON." },
    )
    .optional(),
  send: apiSendOptionsSchema.optional(),
  signers: z
    .array(
      z.object({
        email: z.string(),
        name: z.string(),
        // Part 11 installs need one for each signer before sending.
        signatureMeaning: z.enum(signatureMeanings).optional(),
      }),
    )
    .min(1),
  title: z.string(),
});

// Starts an envelope from a saved template: one signer per role, in the
// template's order. Sends it too when asked.
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  return handleApi(
    request,
    "write",
    "api_template_use_failure",
    async (api) => {
      const raw = await readBodyWithin(request, MAX_JSON_BODY_BYTES);

      if (!raw) {
        return bodyTooLarge();
      }

      const text = new TextDecoder().decode(raw);
      let parsed: unknown;

      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return apiError(400, "invalid_request", "The body is not valid JSON.");
      }

      const body = bodySchema.safeParse(parsed);

      if (!body.success) {
        return apiError(400, "invalid_request", describeZodError(body.error));
      }

      const readBack = async (envelopeId: string) => {
        const envelope = await getApiEnvelope(api.actor.userId, envelopeId);

        return envelope
          ? { body: envelope, status: 201 }
          : {
              body: {
                error: { code: "not_found", message: "Envelope not found." },
              },
              status: 404,
            };
      };

      return runIdempotently(
        api,
        `POST /api/v1/templates/${id}/envelopes`,
        text,
        async (remember) => {
          const draft = await createDraftFromTemplate(api.actor.userId, id, {
            signers: body.data.signers,
            title: body.data.title,
          });

          try {
            await markEnvelopeAsApiMade(
              draft.envelopeId,
              api.actor.apiKeyId,
              body.data.metadata ?? null,
            );

            if (body.data.send) {
              await sendEnvelopeForApi(
                api.actor,
                draft.envelopeId,
                body.data.send,
              );
            }
          } catch (error) {
            await deleteDraftEnvelope(api.actor.userId, draft.envelopeId).catch(
              () => undefined,
            );
            throw error;
          }

          await remember(draft.envelopeId);
          return readBack(draft.envelopeId);
        },
        readBack,
        body.data.send
          ? [API_CREATE_LIMIT, API_SEND_LIMIT]
          : [API_CREATE_LIMIT],
      );
    },
  );
}
