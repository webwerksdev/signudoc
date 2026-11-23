import { createHash } from "node:crypto";

import type pg from "pg";

// Better Auth lets one address sign in three times in ten seconds, and every
// test signs in from this machine. A test that adds a sign-in between others
// would push the next one over that limit, and which test is refused would
// depend on how fast the ones before it ran. Such a test starts the window
// afresh before signing in.

// The addresses the app may see a local request come from, as Better Auth
// keys them. It keeps an IPv6 address to its /64, so ::1, which a runner
// that resolves localhost to IPv6 connects from, is all zeros.
const LOCAL_ADDRESSES = [
  "127.0.0.1",
  "::1",
  "0000:0000:0000:0000:0000:0000:0000:0000",
  "::ffff:127.0.0.1",
  "no-trusted-ip",
];

export async function startSignInWindowAfresh(
  database: pg.Client,
): Promise<void> {
  // The key the app's rate limiter stores (hashed) for Better Auth's
  // sign-in bucket.
  const keys = LOCAL_ADDRESSES.map((address) =>
    createHash("sha256").update(`auth:${address}|/sign-in/email`).digest("hex"),
  );

  await database.query(
    "delete from public.rate_limits where key = any($1::text[])",
    [keys],
  );
}
