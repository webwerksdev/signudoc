// Reading an API request's body with a size limit.

/** The most a JSON-only API request may carry. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * Reads the request body, or returns null as soon as it passes `maxBytes`.
 * The rest is not read, so an oversized request never sits whole in
 * memory, wherever the install runs.
 */
export async function readBodyWithin(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }

  if (!request.body) {
    return new Uint8Array(0);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}
