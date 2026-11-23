import assert from "node:assert/strict";
import { test } from "node:test";

import { auditEventRecordSchema } from "../schemas/envelope.ts";
import {
  getClientIpAddress,
  getClientIpHeaderNames,
  getRequestUserAgent,
} from "./request.ts";

const onVercel = { VERCEL: "1" };
const elsewhere = {};

test("on Vercel, the address Vercel wrote wins over one the visitor could have sent", () => {
  const headers = new Headers({
    "cf-connecting-ip": "198.51.100.9",
    "x-forwarded-for": "198.51.100.7",
    "x-real-ip": "203.0.113.5",
    "x-vercel-forwarded-for": "203.0.113.5",
  });

  assert.equal(getClientIpAddress(headers, onVercel), "203.0.113.5");
  assert.equal(
    getClientIpAddress(
      new Headers({
        "x-forwarded-for": "198.51.100.7",
        "x-real-ip": "203.0.113.5",
      }),
      onVercel,
    ),
    "203.0.113.5",
  );
});

test("off Vercel, Vercel's header means nothing and the proxy headers are used", () => {
  const headers = new Headers({
    "x-forwarded-for": "198.51.100.7, 10.0.0.1",
    "x-vercel-forwarded-for": "203.0.113.5",
  });

  assert.equal(getClientIpAddress(headers, elsewhere), "198.51.100.7");
  assert.equal(
    getClientIpAddress(
      new Headers({ "cf-connecting-ip": "198.51.100.9" }),
      elsewhere,
    ),
    "198.51.100.9",
  );
  assert.equal(
    getClientIpHeaderNames(elsewhere).includes("x-vercel-forwarded-for"),
    false,
  );
});

test("off Vercel, addresses a visitor puts at the start of X-Forwarded-For do not count", () => {
  const read = (value: string) =>
    getClientIpAddress(new Headers({ "x-forwarded-for": value }), elsewhere);

  // A reverse proxy adds the address it saw at the end.
  assert.equal(read("1.2.3.4, 198.51.100.7"), "198.51.100.7");
  // The install's own proxies on a private network are passed over.
  assert.equal(read("1.2.3.4, 198.51.100.7, 10.0.0.1"), "198.51.100.7");
  assert.equal(read("198.51.100.7, 172.16.0.2, fd00::1"), "198.51.100.7");
  // Nothing but private addresses: the first, as before.
  assert.equal(read("192.168.1.20, 10.0.0.1"), "192.168.1.20");
  // On Vercel, Vercel's own header decides, and the list is not read.
  assert.equal(
    getClientIpAddress(
      new Headers({
        "x-forwarded-for": "1.2.3.4, 198.51.100.7",
        "x-vercel-forwarded-for": "203.0.113.5",
      }),
      onVercel,
    ),
    "203.0.113.5",
  );
});

test("an empty header is passed over, and no header at all gives no address", () => {
  assert.equal(
    getClientIpAddress(
      new Headers({ "x-forwarded-for": " ", "x-real-ip": "203.0.113.5" }),
      elsewhere,
    ),
    "203.0.113.5",
  );
  assert.equal(getClientIpAddress(new Headers(), onVercel), null);
});

test("a user agent header with no value counts as no user agent", () => {
  assert.equal(getRequestUserAgent(new Headers()), null);
  assert.equal(getRequestUserAgent(new Headers({ "user-agent": "" })), null);
  assert.equal(getRequestUserAgent(new Headers({ "user-agent": "  " })), null);
  assert.equal(
    getRequestUserAgent(new Headers({ "user-agent": " curl/8.5.0 " })),
    "curl/8.5.0",
  );
});

test("the audit schema accepts what an empty user agent header gives", () => {
  const userAgent = getRequestUserAgent(new Headers({ "user-agent": "" }));

  assert.ok(
    auditEventRecordSchema.shape.userAgent.safeParse(userAgent).success,
  );
});
