import { NextResponse } from "next/server";

import {
  addEmbedOrigin,
  EmbeddingError,
  listEmbedOrigins,
  removeEmbedOrigin,
} from "@/lib/embedding";
import {
  handleWebhookAdmin,
  noStore,
  notAJsonObject,
  readJsonObject,
  type AdminRouteWords,
} from "@/lib/webhooks/admin-route";

// The sites allowed to show signing pages in a frame (embedded signing).
// Administrators only, not on hosted installs.

const EMBEDDING_WORDS: AdminRouteWords = {
  failure: "Unexpected failure in an embedded signing settings request.",
  hosted: "Embedded signing is for self-hosted installs.",
};

function embeddingErrorResponse(error: unknown): Response {
  if (error instanceof EmbeddingError) {
    return NextResponse.json(
      { error: error.message },
      { headers: noStore, status: error.statusCode },
    );
  }

  throw error;
}

export function GET(request: Request) {
  return handleWebhookAdmin(
    request,
    "embed_origin_list_failure",
    async () =>
      NextResponse.json(
        { origins: await listEmbedOrigins() },
        { headers: noStore },
      ),
    EMBEDDING_WORDS,
  );
}

export function POST(request: Request) {
  return handleWebhookAdmin(
    request,
    "embed_origin_add_failure",
    async (actor) => {
      const body = await readJsonObject(request);

      if (!body) {
        return notAJsonObject();
      }

      try {
        const origin = await addEmbedOrigin(actor, body.origin);

        return NextResponse.json({ origin }, { headers: noStore, status: 201 });
      } catch (error) {
        return embeddingErrorResponse(error);
      }
    },
    EMBEDDING_WORDS,
  );
}

export function DELETE(request: Request) {
  return handleWebhookAdmin(
    request,
    "embed_origin_remove_failure",
    async (actor) => {
      const origin = new URL(request.url).searchParams.get("origin") ?? "";

      try {
        await removeEmbedOrigin(actor, origin);

        return NextResponse.json({ removed: true }, { headers: noStore });
      } catch (error) {
        return embeddingErrorResponse(error);
      }
    },
    EMBEDDING_WORDS,
  );
}
