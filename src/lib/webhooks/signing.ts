import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signatures in the Standard Webhooks format
// (https://www.standardwebhooks.com), so a receiver can check them with an
// existing library instead of code written for us:
//
//   webhook-id:        the delivery's id, the same on every try
//   webhook-timestamp: seconds since 1970, when this try was sent
//   webhook-signature: "v1," + base64(HMAC-SHA256(secret, id.timestamp.body))
//
// The secret is "whsec_" + base64 of 32 random bytes; the HMAC key is those
// bytes. During a rotation both secrets sign, and the header carries both
// signatures separated by a space.

export const WEBHOOK_SECRET_PREFIX = "whsec_";

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

function secretBytes(secret: string): Buffer {
  const encoded = secret.startsWith(WEBHOOK_SECRET_PREFIX)
    ? secret.slice(WEBHOOK_SECRET_PREFIX.length)
    : secret;

  return Buffer.from(encoded, "base64");
}

/** One "v1,<base64>" signature of a delivery. */
export function signWebhook(
  secret: string,
  input: { body: string; id: string; timestamp: number },
): string {
  const signature = createHmac("sha256", secretBytes(secret))
    .update(`${input.id}.${String(input.timestamp)}.${input.body}`)
    .digest("base64");

  return `v1,${signature}`;
}

/** The three headers for one try, signed with every secret given. */
export function webhookHeaders(
  secrets: string[],
  input: { body: string; id: string; timestamp: number },
): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "SignuDoc-Webhooks/1",
    "webhook-id": input.id,
    "webhook-signature": secrets
      .map((secret) => signWebhook(secret, input))
      .join(" "),
    "webhook-timestamp": String(input.timestamp),
  };
}

/**
 * Checks a delivery the way a receiver would. Used by the tests, and
 * documented in docs/api.md for receivers without a library.
 */
export function verifyWebhook(
  secret: string,
  input: {
    body: string;
    id: string;
    signatureHeader: string;
    timestamp: number;
  },
  now: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 5 * 60,
): boolean {
  if (Math.abs(now - input.timestamp) > toleranceSeconds) {
    return false;
  }

  const expected = Buffer.from(signWebhook(secret, input));

  return input.signatureHeader.split(" ").some((candidate) => {
    const presented = Buffer.from(candidate);

    return (
      presented.length === expected.length &&
      timingSafeEqual(presented, expected)
    );
  });
}
