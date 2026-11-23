import { createHash } from "node:crypto";

import { MAX_JSON_BODY_BYTES, readBodyWithin } from "@/lib/api/body";
import { apiError, apiJson, bodyTooLarge } from "@/lib/api/http";
import {
  apiCreateEnvelopeSchema,
  apiListQuerySchema,
  createEnvelopeForApi,
  describeZodError,
  getApiEnvelope,
  listApiEnvelopes,
} from "@/lib/api/envelopes";
import {
  API_CREATE_LIMIT,
  API_SEND_LIMIT,
  apiErrorFor,
  handleApi,
  isKept,
  runIdempotently,
} from "@/lib/api/route";
import { pendingUploadKeyFor } from "@/lib/api/uploads";
import {
  discardPendingUpload,
  readPendingUpload,
} from "@/lib/services/pending-uploads";
import { createStorageService } from "@/lib/services/storage";
import { MAX_UPLOAD_SIZE_BYTES } from "@/lib/types/domain";

// GET lists the key's envelopes, newest first. POST creates one from a PDF
// with its signers and fields, and sends it too if asked. See docs/api.md.

export async function GET(request: Request) {
  return handleApi(
    request,
    "read",
    "api_envelope_list_failure",
    async ({ actor }) => {
      const url = new URL(request.url);
      const query = apiListQuerySchema.safeParse({
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
      });

      if (!query.success) {
        return apiError(400, "invalid_request", describeZodError(query.error));
      }

      const page = await listApiEnvelopes(actor.userId, query.data);

      if (!page) {
        return apiError(
          400,
          "invalid_request",
          "cursor: not a cursor this API gave out.",
        );
      }

      return apiJson({
        data: page.data,
        nextCursor: page.nextCursor,
        object: "list",
      });
    },
  );
}

type SourcePdf = { body: Uint8Array; contentType: string; filename: string };

export async function POST(request: Request) {
  return handleApi(
    request,
    "write",
    "api_envelope_create_failure",
    async (context) => {
      const contentType = request.headers.get("content-type") ?? "";
      const isMultipart = contentType
        .toLowerCase()
        .startsWith("multipart/form-data");
      // A PDF comes as multipart, allowed a little over the PDF limit for
      // the form's own parts. Anything else is JSON and held to the JSON
      // limit. Reading stops at the limit, so an oversized request is
      // never held whole.
      const raw = await readBodyWithin(
        request,
        isMultipart ? MAX_UPLOAD_SIZE_BYTES + 256 * 1024 : MAX_JSON_BODY_BYTES,
      );

      if (!raw) {
        return bodyTooLarge();
      }

      let data: unknown;
      let readPdf: () => Promise<SourcePdf>;
      let cleanUp = async () => {};
      let fingerprint: Uint8Array | string = raw;

      if (isMultipart) {
        const form = await new Request(request.url, {
          body: raw,
          headers: { "content-type": contentType },
          method: "POST",
        })
          .formData()
          .catch(() => null);
        const file = form?.get("file");
        const json = form?.get("data");

        if (!(file instanceof File) || typeof json !== "string") {
          return apiError(
            400,
            "invalid_request",
            'Send a "file" part with the PDF and a "data" part with the envelope as JSON.',
          );
        }

        data = parseJson(json);
        const fileBytes = new Uint8Array(await file.arrayBuffer());

        // A multipart body differs on every send (its boundary is random),
        // so a retry is recognised by what it carries instead, file name
        // and type included.
        fingerprint = JSON.stringify([
          json,
          file.name,
          file.type,
          createHash("sha256").update(fileBytes).digest("hex"),
        ]);
        readPdf = async () => ({
          body: fileBytes,
          contentType: file.type || "application/pdf",
          filename: file.name || "document.pdf",
        });
      } else if (contentType.toLowerCase().includes("application/json")) {
        const body = parseJson(new TextDecoder().decode(raw));
        const uploadId =
          typeof body === "object" && body !== null
            ? (body as { uploadId?: unknown }).uploadId
            : undefined;
        const key =
          typeof uploadId === "string"
            ? pendingUploadKeyFor(context.actor.userId, uploadId)
            : null;

        if (!key) {
          return apiError(
            400,
            "invalid_request",
            "Send multipart/form-data with the PDF, or JSON with the uploadId from POST /api/v1/uploads.",
          );
        }

        const filename =
          typeof (body as { filename?: unknown }).filename === "string"
            ? String((body as { filename: string }).filename).slice(0, 255)
            : "document.pdf";
        const storageService = createStorageService();

        data = body;
        readPdf = async () => ({
          body: await readPendingUpload({
            key,
            storageService,
            userId: context.actor.userId,
          }),
          contentType: "application/pdf",
          filename,
        });
        cleanUp = () => discardPendingUpload({ key, storageService });
      } else {
        return apiError(
          400,
          "invalid_request",
          "Send multipart/form-data with the PDF, or JSON with an uploadId.",
        );
      }

      if (data === undefined) {
        return apiError(
          400,
          "invalid_request",
          "The envelope data is not valid JSON.",
        );
      }

      const input = apiCreateEnvelopeSchema.safeParse(data);

      if (!input.success) {
        return apiError(400, "invalid_request", describeZodError(input.error));
      }

      return runIdempotently(
        context,
        "POST /api/v1/envelopes",
        fingerprint,
        async (remember) => {
          let envelope;

          try {
            envelope = await createEnvelopeForApi(
              context.actor,
              input.data,
              await readPdf(),
              undefined,
              { onCreated: remember },
            );
          } catch (error) {
            // Only the request that did the work removes the upload, and
            // only when a retry would get the same refusal: one that is
            // kept for the key. After a failure of the install's own (a
            // 5xx, such as email not being connected) or a 429, the key is
            // let go and the retry needs the upload again.
            const known = apiErrorFor(error);

            if (known && isKept(known.status)) {
              await cleanUp();
            }

            throw error;
          }

          await cleanUp();
          return { body: envelope, status: 201 };
        },
        async (envelopeId) => {
          const envelope = await getApiEnvelope(
            context.actor.userId,
            envelopeId,
          );

          return envelope
            ? { body: envelope, status: 201 }
            : {
                body: {
                  error: { code: "not_found", message: "Envelope not found." },
                },
                status: 404,
              };
        },
        input.data.send
          ? [API_CREATE_LIMIT, API_SEND_LIMIT]
          : [API_CREATE_LIMIT],
      );
    },
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
