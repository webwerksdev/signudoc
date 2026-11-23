import { createHash } from "node:crypto";

import type pg from "pg";

// One account may send ten envelopes an hour (the limit in
// src/app/api/envelopes/[id]/send/route.ts), and together the tests send
// more than that as the administrator. A test that sends starts that count
// afresh, so whether it is refused does not depend on how many ran before.
// The same goes for making drafts: twenty every ten minutes (the limit in
// src/app/api/envelopes/route.ts), which the tests together go past.

export async function startSendLimitAfresh(
  database: pg.Client,
  userId: string,
): Promise<void> {
  await database.query(
    "delete from public.rate_limits where key = any($1::text[])",
    [
      [`envelope-send:${userId}`, `draft-create:${userId}`].map((key) =>
        createHash("sha256").update(key).digest("hex"),
      ),
    ],
  );
}
