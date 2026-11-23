import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for an app that receives SignuDoc's webhooks: it keeps every
// request, and checks signatures the way the Standard Webhooks spec says a
// receiver should.

export type ReceivedWebhook = {
  body: string;
  headers: IncomingHttpHeaders;
  json: { data: Record<string, unknown>; type: string };
};

export async function startWebhookReceiver() {
  const received: ReceivedWebhook[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");

      received.push({
        body,
        headers: request.headers,
        json: JSON.parse(body) as ReceivedWebhook["json"],
      });
      response.writeHead(204);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    received,
    url: `http://127.0.0.1:${String(port)}/signudoc`,
  };
}

/** Whether a received webhook carries a valid signature for `secret`. */
export function hasValidSignature(webhook: ReceivedWebhook, secret: string) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const id = String(webhook.headers["webhook-id"]);
  const timestamp = String(webhook.headers["webhook-timestamp"]);
  const expected = `v1,${createHmac("sha256", key)
    .update(`${id}.${timestamp}.${webhook.body}`)
    .digest("base64")}`;

  return String(webhook.headers["webhook-signature"])
    .split(" ")
    .includes(expected);
}
