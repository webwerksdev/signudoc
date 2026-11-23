import assert from "node:assert/strict";
import { test } from "node:test";

import { readBodyWithin } from "./body.ts";

function streamOf(chunks: string[], onCancel: () => void) {
  const encoder = new TextEncoder();
  let index = 0;

  return new ReadableStream<Uint8Array>({
    cancel: onCancel,
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

function requestWith(body: ReadableStream<Uint8Array>, headers = {}) {
  return new Request("https://sign.example.test/api/v1/envelopes", {
    body,
    // Needed by Node for a streamed body.
    duplex: "half",
    headers,
    method: "POST",
  } as RequestInit);
}

test("a body within the limit is read whole", async () => {
  const body = await readBodyWithin(
    requestWith(streamOf(['{"a":', "1}"], () => undefined)),
    16,
  );

  assert.equal(new TextDecoder().decode(body ?? undefined), '{"a":1}');
});

test("a body over the limit is refused without reading the rest", async () => {
  let cancelled = false;
  const body = await readBodyWithin(
    requestWith(
      streamOf(["12345678", "12345678", "never read"], () => {
        cancelled = true;
      }),
    ),
    10,
  );

  assert.equal(body, null);
  assert.equal(cancelled, true);
});

test("a declared length over the limit is refused before reading", async () => {
  const request = requestWith(
    streamOf(["12345678901234567890"], () => undefined),
    { "content-length": "100" },
  );

  assert.equal(await readBodyWithin(request, 10), null);
  assert.equal(request.bodyUsed, false);
});

test("no body reads as empty", async () => {
  const body = await readBodyWithin(
    new Request("https://sign.example.test/api/v1/envelopes/x/void", {
      method: "POST",
    }),
    10,
  );

  assert.equal(body?.byteLength, 0);
});
