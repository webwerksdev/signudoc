import assert from "node:assert/strict";
import test from "node:test";

import { frameAncestorsFor, parseEmbedOrigin } from "./embed-origin.ts";

test("an embed origin is one exact https site", () => {
  const env = {};

  assert.equal(
    parseEmbedOrigin("https://app.example.com", env),
    "https://app.example.com",
  );
  assert.equal(
    parseEmbedOrigin("https://App.Example.com/", env),
    "https://app.example.com",
  );
  assert.equal(
    parseEmbedOrigin("https://app.example.com:8443", env),
    "https://app.example.com:8443",
  );

  for (const bad of [
    "http://app.example.com",
    "https://app.example.com/path",
    "https://app.example.com?x=1",
    "https://*.example.com",
    "https://user@app.example.com",
    "app.example.com",
    "javascript:alert(1)",
    "",
    null,
    42,
  ]) {
    assert.equal(parseEmbedOrigin(bad, env), null, String(bad));
  }
});

test("plain http origins only when asked for, and never on Vercel", () => {
  assert.equal(
    parseEmbedOrigin("http://127.0.0.1:4000", {
      EMBED_ALLOW_HTTP_ORIGINS: "1",
    }),
    "http://127.0.0.1:4000",
  );
  assert.equal(
    parseEmbedOrigin("http://127.0.0.1:4000", {
      EMBED_ALLOW_HTTP_ORIGINS: "1",
      VERCEL: "1",
    }),
    null,
  );
});

test("only an embedded signing page may be framed, and only by the site it names", () => {
  const env = {};
  const named = new URLSearchParams({ origin: "https://app.example.com" });

  assert.equal(
    frameAncestorsFor("/embed/sign/abc", named, env),
    "https://app.example.com",
  );
  assert.equal(frameAncestorsFor("/sign/abc", named, env), "'none'");
  assert.equal(frameAncestorsFor("/settings", named, env), "'none'");
  assert.equal(
    frameAncestorsFor(
      "/embed/sign/abc",
      new URLSearchParams({
        origin: "https://a.example.com https://b.example.com",
      }),
      env,
    ),
    "'none'",
  );
  assert.equal(
    frameAncestorsFor(
      "/embed/sign/abc",
      new URLSearchParams({ origin: "https://app.example.com; script-src *" }),
      env,
    ),
    "'none'",
  );
  assert.equal(
    frameAncestorsFor("/embed/sign/abc", new URLSearchParams(), env),
    "'none'",
  );
});
