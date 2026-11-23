import assert from "node:assert/strict";
import { test } from "node:test";

import { getInitials } from "./initials.ts";

function isWellFormed(value: string): boolean {
  return value === value.toWellFormed();
}

// The name from issue #115: the emoji is a word of its own.
test("an emoji word does not leave half an emoji in the initials", () => {
  const initials = getInitials("Robin Casey 😀", { max: 4 });

  assert.ok(isWellFormed(initials), JSON.stringify(initials));
  assert.equal(initials, "RC");
});

test("the control name from issue #115 still gives three initials", () => {
  assert.equal(getInitials("Robin Casey D", { max: 4 }), "RCD");
});

test("a word that starts with an emoji keeps the emoji whole", () => {
  for (const name of ["😀", "😀 😎", "👩🏽‍💻"]) {
    const initials = getInitials(name, { max: 4 });

    assert.ok(isWellFormed(initials), JSON.stringify(initials));
    assert.ok(initials.length > 0);
    assert.ok(name.startsWith(initials), `${name} -> ${initials}`);
  }
});

test("a letter with a combining accent stays in one piece", () => {
  assert.equal(getInitials("élodie Roy", { max: 2 }), "ÉR");
});

test("a lone surrogate in a stored name is never copied out", () => {
  const initials = getInitials("\ud83d Robin", { max: 4 });

  assert.ok(isWellFormed(initials), JSON.stringify(initials));
  assert.equal(initials, "R");
});

test("max and single-word length match each avatar", () => {
  assert.equal(getInitials("Ana Bea Cruz Dee Eve", { max: 4 }), "ABCD");
  assert.equal(getInitials("Ana Bea Cruz", { max: 2 }), "AB");
  assert.equal(getInitials("Robin", { max: 2 }), "R");
  assert.equal(getInitials("Robin", { max: 2, singleWordLength: 2 }), "RO");
  assert.equal(getInitials("Robin 😀", { max: 2, singleWordLength: 2 }), "RO");
  assert.equal(getInitials("   ", { max: 2 }), "");
});

test("uppercasing that lengthens a letter still respects max", () => {
  assert.equal(getInitials("ßeta Roy", { max: 2 }), "SS");
  assert.equal(getInitials("Anna ßeta Roy", { max: 2 }), "AS");
});
