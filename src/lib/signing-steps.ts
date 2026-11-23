import type { SignerStatus } from "./types/domain.ts";

// The signing order is a list of steps. Each signer is in one step, and the
// signers who share a step sign at the same time: they are all invited when
// the step starts, in any order among themselves. The next step starts
// once every signer of the step before has signed. A list where every
// signer has a step of their own is the plain one-after-the-other order.
//
// sign_order is a signer's place in the list and stays unique; the step is
// signers.signing_step. A row without one (written before steps existed,
// or by hand) is in the step of its place in the list.

export type SteppedSigner = {
  /** The place in the list, from 1. Optional only because drafts' types are. */
  signOrder?: number;
  signingStep?: number | null;
};

export type SteppedSignerWithStatus = SteppedSigner & {
  id?: string;
  status: SignerStatus;
};

export class SigningStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SigningStepError";
  }
}

export function signingStepOf(signer: SteppedSigner): number {
  return typeof signer.signingStep === "number" && signer.signingStep > 0
    ? signer.signingStep
    : (signer.signOrder ?? 0);
}

/**
 * The steps to store for a list of signers, given in the list's order. With
 * no steps given, each signer gets their own, one after the other. Given
 * steps must not go down the list, and are renumbered 1, 2, 3 without gaps,
 * so "1, 1, 4" is stored as "1, 1, 2".
 */
export function normalizeSigningSteps(
  requested: readonly (number | null | undefined)[],
): number[] {
  const given = requested.filter(
    (step): step is number => typeof step === "number",
  );

  if (given.length === 0) {
    return requested.map((_, index) => index + 1);
  }

  if (given.length !== requested.length) {
    throw new SigningStepError(
      "Give every signer a step in the signing order, or none of them.",
    );
  }

  const steps: number[] = [];
  let previous: number | null = null;
  let current = 0;

  for (const step of given) {
    if (!Number.isInteger(step) || step < 1) {
      throw new SigningStepError("Steps in the signing order start at 1.");
    }

    if (previous !== null && step < previous) {
      throw new SigningStepError(
        "List the signers in signing order: a later step cannot come before an earlier one.",
      );
    }

    if (step !== previous) {
      current += 1;
      previous = step;
    }

    steps.push(current);
  }

  return steps;
}

/** True when at least two signers sign at the same time. */
export function hasSharedSigningStep(
  signers: readonly SteppedSigner[],
): boolean {
  const seen = new Set<number>();

  for (const signer of signers) {
    const step = signingStepOf(signer);

    if (seen.has(step)) {
      return true;
    }

    seen.add(step);
  }

  return false;
}

/** The signers of the first step, in list order. */
export function firstStepSigners<T extends SteppedSigner>(
  signers: readonly T[],
): T[] {
  if (signers.length === 0) {
    return [];
  }

  const first = Math.min(...signers.map(signingStepOf));

  return sortByPlace(
    signers.filter((signer) => signingStepOf(signer) === first),
  );
}

/**
 * What happens to the order once the signers marked signed have signed:
 * who is still waiting in the current step, and, when nobody is, who is
 * invited next. Nobody waiting and nobody next means everyone has signed.
 */
export function routeAfterSignatures<T extends SteppedSignerWithStatus>(
  signers: readonly T[],
): { next: T[]; waiting: T[] } {
  const waiting = sortByPlace(
    signers.filter((signer) => signer.status === "notified"),
  );

  if (waiting.length > 0) {
    return { next: [], waiting };
  }

  const pending = signers.filter((signer) => signer.status === "pending");

  return { next: firstStepSigners(pending), waiting: [] };
}

function sortByPlace<T extends SteppedSigner>(signers: readonly T[]): T[] {
  return [...signers].sort(
    (left, right) => (left.signOrder ?? 0) - (right.signOrder ?? 0),
  );
}

/**
 * Every signer whose step comes before this one's. Their fields are already
 * filled in when this signer's turn starts. Signers of the same step may or
 * may not have signed yet.
 */
export function isEarlierStep(
  signer: SteppedSigner,
  than: SteppedSigner,
): boolean {
  return signingStepOf(signer) < signingStepOf(than);
}

/** "Alex", "Alex and Sam", "Alex, Sam and Kim". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }

  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * On the signers page each signer after the first either signs at the same
 * time as the one above (`withPrevious`) or starts the next step.
 */
export type ListedSigner = { withPrevious: boolean };

/** Each listed signer's step, from 1. */
function listedSteps(signers: readonly ListedSigner[]): number[] {
  const steps: number[] = [];

  for (const [index, signer] of signers.entries()) {
    const previous = steps[index - 1];

    steps.push(
      previous === undefined
        ? 1
        : signer.withPrevious
          ? previous
          : previous + 1,
    );
  }

  return steps;
}

/** The signers, each with the step given for them in `steps`. */
function inSteps<T extends ListedSigner>(
  signers: readonly T[],
  steps: readonly number[],
): T[] {
  return signers.map((signer, index) => {
    const withPrevious = index > 0 && steps[index] === steps[index - 1];

    return signer.withPrevious === withPrevious
      ? signer
      : { ...signer, withPrevious };
  });
}

/**
 * The list without the signer at `index`. Everyone else stays in their
 * step: the signer after one who started a step does not join the step
 * before.
 */
export function removeListedSigner<T extends ListedSigner>(
  signers: readonly T[],
  index: number,
): T[] {
  const keep = (_: unknown, at: number) => at !== index;

  return inSteps(signers.filter(keep), listedSteps(signers).filter(keep));
}

/**
 * The list with the signer at `index` moved one place earlier or later.
 * Everyone else stays in their step. The moved signer stays in theirs when
 * changing places with someone of the same step, joins a step they land in
 * the middle of, and otherwise has a step of their own.
 */
export function moveListedSigner<T extends ListedSigner>(
  signers: T[],
  index: number,
  direction: "earlier" | "later",
): T[] {
  const target = direction === "earlier" ? index - 1 : index + 1;

  if (index < 0 || target < 0 || target >= signers.length) {
    return signers;
  }

  const steps = listedSteps(signers);
  const step = steps[index]!;
  const moved = [...signers];
  const movedSteps = [...steps];
  const [signer] = moved.splice(index, 1);

  movedSteps.splice(index, 1);

  const before = movedSteps[target - 1];
  const after = movedSteps[target];
  // 0 is no step's number, so it is a step of their own.
  const newStep =
    steps[target] === step
      ? step
      : before !== undefined && before === after
        ? before
        : 0;

  moved.splice(target, 0, signer!);
  movedSteps.splice(target, 0, newStep);

  return inSteps(moved, movedSteps);
}
