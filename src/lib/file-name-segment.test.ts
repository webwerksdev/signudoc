import assert from "node:assert/strict";
import { test } from "node:test";

import { sanitizeFileNameSegment } from "./downloads.ts";
import { buildContentDisposition } from "./services/storage.ts";

function isWellFormed(value: string): boolean {
  return value === value.toWellFormed();
}

// The title from issue #89: the cut at 120 lands inside the emoji.
const splitTitle = `${"Example ".repeat(14)}TitleAA😀A`;
const controlTitle = `B${"Example ".repeat(14)}TitleAA😀`;

test("a cut that lands inside an emoji drops the whole emoji", () => {
  const segment = sanitizeFileNameSegment(splitTitle);

  assert.ok(isWellFormed(segment), JSON.stringify(segment));
  assert.ok(segment.length <= 120);
  assert.equal(segment, `${"Example ".repeat(14)}TitleAA`);
});

test("a joined emoji is kept or dropped in one piece", () => {
  const family = "👨‍👩‍👧";
  const segment = sanitizeFileNameSegment(`${"a".repeat(117)}${family}`);

  assert.equal(segment, "a".repeat(117));
  assert.equal(
    sanitizeFileNameSegment(`${"a".repeat(112)}${family}`),
    `${"a".repeat(112)}${family}`,
  );
});

test("a cut leaves no space or dot at the end of the name", () => {
  assert.equal(
    sanitizeFileNameSegment(`${"a".repeat(119)} b`),
    "a".repeat(119),
  );
  assert.equal(
    sanitizeFileNameSegment(`${"a".repeat(118)}..b`),
    "a".repeat(118),
  );
});

test("a short title is left as it is", () => {
  assert.equal(sanitizeFileNameSegment("NDA 😀 Acme"), "NDA 😀 Acme");
});

test("both issue titles give a download header a response accepts", () => {
  for (const title of [splitTitle, controlTitle]) {
    for (const suffix of [" - signed.pdf", " - certificate.pdf"]) {
      const fileName = `${sanitizeFileNameSegment(title)}${suffix}`;
      const value = buildContentDisposition(fileName);
      const response = new Response("", {
        headers: { "content-disposition": value },
      });

      assert.equal(response.headers.get("content-disposition"), value);
      const encoded = value.split("filename*=UTF-8''")[1] ?? "";
      assert.equal(decodeURIComponent(encoded), fileName);
    }
  }
});

test("a lone surrogate in a file name does not make the header throw", () => {
  const value = buildContentDisposition("Report \ud83d.pdf");

  assert.ok(value.endsWith("filename*=UTF-8''Report%20%EF%BF%BD.pdf"), value);
});
