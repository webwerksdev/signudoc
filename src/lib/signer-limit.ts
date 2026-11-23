import {
  DEFAULT_MAX_SIGNERS_PER_ENVELOPE,
  MAX_SIGNERS_CEILING,
} from "./types/domain.ts";
import { type EnvSource, readEnv } from "./utils/env.ts";

// How many signers one envelope may have on this install, up to
// MAX_SIGNERS_CEILING (the certificate runs onto as many pages as it
// needs). A value that is not a whole number in range is ignored, and the
// default applies, rather than stopping the app.

export function getMaxSignersPerEnvelope(env: EnvSource = process.env): number {
  const configured = readEnv(env, "MAX_SIGNERS_PER_ENVELOPE");

  if (!configured || !/^\d+$/.test(configured)) {
    return DEFAULT_MAX_SIGNERS_PER_ENVELOPE;
  }

  const value = Number(configured);

  return value >= 1 && value <= MAX_SIGNERS_CEILING
    ? value
    : DEFAULT_MAX_SIGNERS_PER_ENVELOPE;
}

export function describeSignerLimit(limit: number): string {
  return `An envelope can have at most ${String(limit)} ${limit === 1 ? "signer" : "signers"}.`;
}
