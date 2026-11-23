import assert from "node:assert/strict";
import { test } from "node:test";

import {
  generateApiKey,
  hashApiKey,
  looksLikeApiKey,
  parseApiKeyExpiry,
  parseApiKeyName,
  parseApiKeyScope,
  readBearerToken,
  scopeAllows,
} from "./api-keys.ts";

test("a new key has the fixed prefix and 256 bits of randomness", () => {
  const key = generateApiKey();

  assert.match(key, /^sdk_[A-Za-z0-9_-]{43}$/);
  assert.ok(looksLikeApiKey(key));
  assert.notEqual(generateApiKey(), key);
});

test("only the shape of our keys is looked up", () => {
  assert.equal(looksLikeApiKey("sdk_short"), false);
  assert.equal(looksLikeApiKey(`sk_${"a".repeat(43)}`), false);
  assert.equal(looksLikeApiKey(`sdk_${"a".repeat(43)}!`), false);
});

test("the hash is SHA-256 in hex", () => {
  assert.equal(
    hashApiKey("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("the bearer token is read whatever the scheme's case", () => {
  const key = generateApiKey();

  assert.equal(
    readBearerToken(new Headers({ authorization: `Bearer ${key}` })),
    key,
  );
  assert.equal(
    readBearerToken(new Headers({ authorization: `bearer   ${key} ` })),
    key,
  );
  assert.equal(
    readBearerToken(new Headers({ authorization: `Basic ${key}` })),
    null,
  );
  assert.equal(readBearerToken(new Headers()), null);
});

test("write access includes read, read does not include write", () => {
  assert.equal(scopeAllows("write", "read"), true);
  assert.equal(scopeAllows("write", "write"), true);
  assert.equal(scopeAllows("read", "read"), true);
  assert.equal(scopeAllows("read", "write"), false);
});

test("names, scopes and expiries are checked", () => {
  assert.equal(parseApiKeyName("  Billing   app "), "Billing app");
  assert.equal(parseApiKeyName(""), null);
  assert.equal(parseApiKeyName("x".repeat(81)), null);
  assert.equal(parseApiKeyScope("read"), "read");
  assert.equal(parseApiKeyScope("admin"), null);
  assert.equal(parseApiKeyExpiry(90), 90);
  assert.equal(parseApiKeyExpiry("365"), 365);
  assert.equal(parseApiKeyExpiry(null), null);
  assert.equal(parseApiKeyExpiry("never"), null);
  assert.equal(parseApiKeyExpiry(7), undefined);
});
