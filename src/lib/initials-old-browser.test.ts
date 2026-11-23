import assert from "node:assert/strict";
import { test } from "node:test";

// Firefox 115 ESR has neither Intl.Segmenter nor String.prototype.toWellFormed.
// Remove both before the helpers load, so this file runs the code path those
// browsers take. Each test file runs in its own process.
Reflect.deleteProperty(Intl, "Segmenter");
Reflect.deleteProperty(String.prototype, "toWellFormed");

const { getInitials } = await import("./initials.ts");
const { truncateToWholeCharacters } = await import("./text-truncate.ts");

function isWellFormed(value: string): boolean {
  return !/[\uD800-\uDFFF]/.test(
    value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""),
  );
}

test("initials load and stay whole without Intl.Segmenter", () => {
  assert.equal(typeof Intl.Segmenter, "undefined");
  assert.equal(getInitials("Robin Casey 😀", { max: 4 }), "RC");
  assert.equal(getInitials("Robin Casey D", { max: 4 }), "RCD");
  assert.equal(getInitials("👩🏽‍💻", { max: 4 }), "👩🏽‍💻");
  assert.equal(getInitials("\ud83d Robin", { max: 4 }), "R");
});

test("typed initials are cut at whole characters without Intl.Segmenter", () => {
  const cut = truncateToWholeCharacters("AB😀C", 3);

  assert.ok(isWellFormed(cut), JSON.stringify(cut));
  assert.equal(cut, "AB");
});
