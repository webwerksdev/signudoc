import { apiJson } from "@/lib/api/http";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { getEnv } from "@/lib/utils/env";

// The OpenAPI description of this API. Needs no key.
export function GET(request: Request) {
  const origin = getEnv(process.env).appUrl ?? new URL(request.url).origin;

  return apiJson(buildOpenApiDocument(new URL("/api/v1", origin).toString()));
}
