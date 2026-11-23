import assert from "node:assert/strict";
import { test } from "node:test";

import { getMaxSignersPerEnvelope } from "./signer-limit.ts";
import {
  firstStepSigners,
  hasSharedSigningStep,
  isEarlierStep,
  joinNames,
  moveListedSigner,
  normalizeSigningSteps,
  removeListedSigner,
  routeAfterSignatures,
  signingStepOf,
  SigningStepError,
} from "./signing-steps.ts";
import {
  DEFAULT_MAX_SIGNERS_PER_ENVELOPE,
  MAX_SIGNERS_CEILING,
} from "./types/domain.ts";

test("with no steps given, signers sign one after the other", () => {
  assert.deepEqual(
    normalizeSigningSteps([undefined, undefined, undefined]),
    [1, 2, 3],
  );
});

test("given steps are renumbered without gaps", () => {
  assert.deepEqual(normalizeSigningSteps([1, 1, 4, 4, 7]), [1, 1, 2, 2, 3]);
  assert.deepEqual(normalizeSigningSteps([3, 3]), [1, 1]);
});

test("steps cannot go down the list, start below 1, or be given for only some", () => {
  assert.throws(() => normalizeSigningSteps([2, 1]), SigningStepError);
  assert.throws(() => normalizeSigningSteps([0, 1]), SigningStepError);
  assert.throws(() => normalizeSigningSteps([1, undefined]), SigningStepError);
  assert.throws(() => normalizeSigningSteps([1.5]), SigningStepError);
});

test("a signer without a stored step is in the step of its place", () => {
  assert.equal(signingStepOf({ signOrder: 3 }), 3);
  assert.equal(signingStepOf({ signOrder: 3, signingStep: null }), 3);
  assert.equal(signingStepOf({ signOrder: 3, signingStep: 1 }), 1);
});

test("shared steps are found", () => {
  assert.equal(
    hasSharedSigningStep([
      { signOrder: 1, signingStep: 1 },
      { signOrder: 2, signingStep: 2 },
    ]),
    false,
  );
  assert.equal(
    hasSharedSigningStep([
      { signOrder: 1, signingStep: 1 },
      { signOrder: 2, signingStep: 1 },
    ]),
    true,
  );
});

test("the first step is everyone who shares the lowest step", () => {
  const signers = [
    { id: "c", signOrder: 3, signingStep: 2 },
    { id: "b", signOrder: 2, signingStep: 1 },
    { id: "a", signOrder: 1, signingStep: 1 },
  ];

  assert.deepEqual(
    firstStepSigners(signers).map((signer) => signer.id),
    ["a", "b"],
  );
});

test("the next step starts only when nobody in the current one is waiting", () => {
  const route = (statuses: string[]) =>
    routeAfterSignatures([
      { id: "a", signOrder: 1, signingStep: 1, status: statuses[0] },
      { id: "b", signOrder: 2, signingStep: 1, status: statuses[1] },
      { id: "c", signOrder: 3, signingStep: 2, status: statuses[2] },
      { id: "d", signOrder: 4, signingStep: 2, status: statuses[3] },
      { id: "e", signOrder: 5, signingStep: 3, status: statuses[4] },
    ] as Parameters<typeof routeAfterSignatures>[0]);
  const ids = (signers: { id?: string }[]) =>
    signers.map((signer) => signer.id);

  let next = route(["signed", "notified", "pending", "pending", "pending"]);
  assert.deepEqual(ids(next.waiting), ["b"]);
  assert.deepEqual(ids(next.next), []);

  next = route(["signed", "signed", "pending", "pending", "pending"]);
  assert.deepEqual(ids(next.waiting), []);
  assert.deepEqual(ids(next.next), ["c", "d"]);

  next = route(["signed", "signed", "signed", "signed", "signed"]);
  assert.deepEqual(ids(next.waiting), []);
  assert.deepEqual(ids(next.next), []);
});

test("earlier steps are told apart from the same step", () => {
  assert.equal(
    isEarlierStep(
      { signOrder: 1, signingStep: 1 },
      { signOrder: 2, signingStep: 1 },
    ),
    false,
  );
  assert.equal(
    isEarlierStep(
      { signOrder: 1, signingStep: 1 },
      { signOrder: 3, signingStep: 2 },
    ),
    true,
  );
});

test("names are joined for a sentence", () => {
  assert.equal(joinNames([]), "");
  assert.equal(joinNames(["Alex"]), "Alex");
  assert.equal(joinNames(["Alex", "Sam"]), "Alex and Sam");
  assert.equal(joinNames(["Alex", "Sam", "Kim"]), "Alex, Sam and Kim");
});

test("the signer limit comes from the environment, within bounds", () => {
  assert.equal(getMaxSignersPerEnvelope({}), DEFAULT_MAX_SIGNERS_PER_ENVELOPE);
  assert.equal(
    getMaxSignersPerEnvelope({ MAX_SIGNERS_PER_ENVELOPE: "40" }),
    40,
  );
  assert.equal(
    getMaxSignersPerEnvelope({
      MAX_SIGNERS_PER_ENVELOPE: String(MAX_SIGNERS_CEILING + 1),
    }),
    DEFAULT_MAX_SIGNERS_PER_ENVELOPE,
  );
  assert.equal(
    getMaxSignersPerEnvelope({ MAX_SIGNERS_PER_ENVELOPE: "0" }),
    DEFAULT_MAX_SIGNERS_PER_ENVELOPE,
  );
  assert.equal(
    getMaxSignersPerEnvelope({ MAX_SIGNERS_PER_ENVELOPE: "ten" }),
    DEFAULT_MAX_SIGNERS_PER_ENVELOPE,
  );
});

/** A list on the signers page, from each signer's step: "A1 B2 C2". */
function listed(spec: string) {
  const entries = spec.split(" ").map((entry) => ({
    name: entry[0]!,
    step: Number(entry.slice(1)),
  }));

  return entries.map(({ name, step }, index) => ({
    name,
    withPrevious: index > 0 && entries[index - 1]!.step === step,
  }));
}

/** The same list written back as "A1 B2 C2", steps numbered from 1. */
function described(
  signers: readonly { name: string; withPrevious: boolean }[],
) {
  let step = 0;

  return signers
    .map((signer, index) => {
      step += index > 0 && signer.withPrevious ? 0 : 1;
      return `${signer.name}${String(step)}`;
    })
    .join(" ");
}

test("removing a signer leaves everyone else in their step", () => {
  // B started step 2; C, who signs with B, does not move up to A's step.
  assert.equal(described(removeListedSigner(listed("A1 B2 C2"), 1)), "A1 C2");
  assert.equal(
    described(removeListedSigner(listed("A1 B2 C2 D2"), 1)),
    "A1 C2 D2",
  );
  assert.equal(described(removeListedSigner(listed("A1 B1 C2"), 0)), "B1 C2");
  assert.equal(described(removeListedSigner(listed("A1 B2 C3"), 1)), "A1 C2");
  assert.equal(
    described(removeListedSigner(listed("A1 B1 C2 D2"), 3)),
    "A1 B1 C2",
  );
});

test("moving a signer leaves everyone else in their step", () => {
  // Changing places within a step keeps both in it.
  assert.equal(
    described(moveListedSigner(listed("A1 B2 C2"), 2, "earlier")),
    "A1 C2 B2",
  );
  assert.equal(
    described(moveListedSigner(listed("A1 B1 C2"), 0, "later")),
    "B1 A1 C2",
  );
  // Out of a step: a step of their own, and the one left behind keeps theirs.
  assert.equal(
    described(moveListedSigner(listed("A1 B2 C2"), 1, "earlier")),
    "B1 A2 C3",
  );
  assert.equal(
    described(moveListedSigner(listed("A1 B1 C2"), 1, "later")),
    "A1 C2 B3",
  );
  assert.equal(
    described(moveListedSigner(listed("A1 B2 C3"), 2, "earlier")),
    "A1 C2 B3",
  );
  // Into the middle of a step: they join it, which stays together.
  assert.equal(
    described(moveListedSigner(listed("A1 B2 C2 D3"), 3, "earlier")),
    "A1 B2 D2 C2",
  );
  // Past either end: nothing moves.
  const list = listed("A1 B2");

  assert.equal(moveListedSigner(list, 0, "earlier"), list);
  assert.equal(moveListedSigner(list, 1, "later"), list);
});
