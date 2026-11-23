import { NextResponse } from "next/server";

// Responses for the public API (/api/v1). Every error has the same shape,
// {"error": {"code": "…", "message": "…"}}, and the codes do not change
// within a version. See docs/api.md.

export type ApiErrorCode =
  | "forbidden"
  | "idempotency_key_reused"
  | "internal_error"
  | "invalid_request"
  | "not_found"
  | "payload_too_large"
  | "rate_limited"
  | "unauthorized"
  | "wrong_state";

const NO_STORE = "private, no-store";

export function apiJson(
  body: unknown,
  init: { headers?: Record<string, string>; status?: number } = {},
) {
  const response = NextResponse.json(body, {
    headers: init.headers,
    status: init.status ?? 200,
  });

  response.headers.set("cache-control", NO_STORE);
  return response;
}

export function apiError(
  status: number,
  code: ApiErrorCode,
  message: string,
  headers: Record<string, string> = {},
) {
  return apiJson({ error: { code, message } }, { headers, status });
}

/** The code that fits an HTTP status the app's own errors carry. */
export function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "wrong_state";
    case 413:
      return "payload_too_large";
    case 429:
      return "rate_limited";
    default:
      return status >= 500 ? "internal_error" : "invalid_request";
  }
}

/** The answer when a body is over its limit. */
export function bodyTooLarge() {
  return apiError(413, "payload_too_large", "The request is too large.");
}
