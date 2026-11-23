import assert from "node:assert/strict";
import test from "node:test";

import {
  generateWebhookSecret,
  signWebhook,
  verifyWebhook,
  webhookHeaders,
} from "./signing.ts";

// The example from the Standard Webhooks specification, so receivers using
// any of its libraries accept what we send.
// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
test("signatures match the Standard Webhooks example", () => {
  assert.equal(
    signWebhook("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", {
      body: '{"test": 2432232314}',
      id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
      timestamp: 1614265330,
    }),
    "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  );
});

test("a secret is whsec_ and 32 random bytes", () => {
  const secret = generateWebhookSecret();

  assert.match(secret, /^whsec_[A-Za-z0-9+/]{43}=$/);
  assert.notEqual(secret, generateWebhookSecret());
});

test("both secrets sign during a rotation, and either one verifies", () => {
  const current = generateWebhookSecret();
  const previous = generateWebhookSecret();
  const input = {
    body: '{"type":"envelope.sent"}',
    id: "msg_1",
    timestamp: 1000,
  };
  const headers = webhookHeaders([current, previous], input);

  assert.equal(headers["webhook-signature"]!.split(" ").length, 2);

  for (const secret of [current, previous]) {
    assert.ok(
      verifyWebhook(
        secret,
        { ...input, signatureHeader: headers["webhook-signature"]! },
        1000,
      ),
    );
  }

  assert.ok(
    !verifyWebhook(
      generateWebhookSecret(),
      { ...input, signatureHeader: headers["webhook-signature"]! },
      1000,
    ),
  );
});

test("a changed body, or an old timestamp, does not verify", () => {
  const secret = generateWebhookSecret();
  const input = { body: '{"a":1}', id: "msg_1", timestamp: 1000 };
  const signatureHeader = signWebhook(secret, input);

  assert.ok(
    !verifyWebhook(
      secret,
      { ...input, body: '{"a":2}', signatureHeader },
      1000,
    ),
  );
  assert.ok(!verifyWebhook(secret, { ...input, signatureHeader }, 1000 + 301));
});
