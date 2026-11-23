import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import { isPrivateAddress } from "../services/private-address.ts";
import type { EnvSource } from "../utils/env.ts";

// POSTs a webhook to a URL an administrator typed in, without letting that
// URL reach inside the network the app runs in: the name is resolved, the
// request is refused if any address it gives is private, loopback or
// link-local (cloud metadata lives there), and the connection goes to the
// address that was checked, so a second lookup cannot swap it. Redirects
// are not followed. Only the first few KB of the answer are read.

export const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4096;

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookUrlError";
  }
}

/**
 * Private and plain-http URLs, for a receiver on the same machine while
 * developing or testing. Never on Vercel, whatever the variable says.
 */
export function privateWebhookUrlsAllowed(
  env: EnvSource = process.env,
): boolean {
  return env.WEBHOOK_ALLOW_PRIVATE_URLS === "1" && !env.VERCEL;
}

/** The URL as stored, or an error that says what is wrong with it. */
export function parseWebhookUrl(
  value: unknown,
  env: EnvSource = process.env,
): URL {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WebhookUrlError("Enter the URL to send events to.");
  }

  if (value.length > 2048) {
    throw new WebhookUrlError("The URL is too long.");
  }

  let url: URL;

  try {
    url = new URL(value.trim());
  } catch {
    throw new WebhookUrlError("That is not a URL.");
  }

  const allowPrivate = privateWebhookUrlsAllowed(env);

  if (
    url.protocol !== "https:" &&
    !(allowPrivate && url.protocol === "http:")
  ) {
    throw new WebhookUrlError("The URL must start with https://.");
  }

  if (url.username || url.password) {
    throw new WebhookUrlError(
      "Leave the user name and password out of the URL. Check the signature instead.",
    );
  }

  if (url.hash) {
    url.hash = "";
  }

  if (!allowPrivate && isPrivateAddress(url.hostname)) {
    throw new WebhookUrlError(
      "The URL points at a private or local address, which the app will not call.",
    );
  }

  return url;
}

type AddressLookup = (
  hostname: string,
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

const systemLookup: AddressLookup = (hostname, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    callback(error, addresses ?? []);
  });
};

function guardedLookup(
  resolve: AddressLookup,
  allowPrivate: boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, found) => {
      const family = options.family === 6 ? 6 : options.family === 4 ? 4 : 0;
      const addresses = found.filter(
        (address) => family === 0 || address.family === family,
      );

      if (error || addresses.length === 0) {
        callback(
          error ?? new WebhookUrlError(`${hostname} has no address.`),
          "",
        );
        return;
      }

      const blocked = addresses.find((address) =>
        isPrivateAddress(address.address),
      );

      if (blocked && !allowPrivate) {
        callback(
          new WebhookUrlError(
            `Refused to call a private address (${hostname} is ${blocked.address}).`,
          ),
          "",
        );
        return;
      }

      if (options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}

export type WebhookPostResult =
  | { body: string; ok: boolean; status: number }
  | { error: string; ok: false; status: null };

/** POSTs once. Never throws: a failure comes back as a result to log. */
export function postWebhook(
  url: string,
  input: { body: string; headers: Record<string, string> },
  options: {
    env?: EnvSource;
    lookup?: AddressLookup;
    timeoutMs?: number;
  } = {},
): Promise<WebhookPostResult> {
  const env = options.env ?? process.env;
  let target: URL;

  try {
    target = parseWebhookUrl(url, env);
  } catch (error) {
    return Promise.resolve({
      error: error instanceof Error ? error.message : "Not a usable URL.",
      ok: false,
      status: null,
    });
  }

  const allowPrivate = privateWebhookUrlsAllowed(env);
  const body = Buffer.from(input.body, "utf8");

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WebhookPostResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = send(
      target,
      {
        // A fresh connection each time, so each one goes through the check.
        agent: false,
        headers: { ...input.headers, "content-length": String(body.length) },
        lookup: guardedLookup(options.lookup ?? systemLookup, allowPrivate),
        method: "POST",
        signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;

        response.on("data", (chunk: Buffer) => {
          if (size < MAX_RESPONSE_BYTES) {
            chunks.push(chunk);
            size += chunk.length;
          }

          if (size >= MAX_RESPONSE_BYTES) {
            response.destroy();
            done();
          }
        });

        const done = () => {
          finish({
            body: Buffer.concat(chunks)
              .subarray(0, MAX_RESPONSE_BYTES)
              .toString("utf8"),
            ok: status >= 200 && status < 300,
            status,
          });
        };

        response.on("end", done);
        response.on("error", done);
        response.on("close", done);
      },
    );

    outgoing.on("error", (error: Error) => {
      finish({
        error:
          error.name === "TimeoutError" || error.name === "AbortError"
            ? `No answer within ${String((options.timeoutMs ?? WEBHOOK_TIMEOUT_MS) / 1000)} seconds.`
            : error.message,
        ok: false,
        status: null,
      });
    });
    outgoing.end(body);
  });
}
