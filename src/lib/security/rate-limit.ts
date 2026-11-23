import { createHash } from "node:crypto";

import { getDb, type DbExecutor } from "../db/connection.ts";

// Rate limits are counted in Postgres, in the rate_limits table: on Vercel
// the app runs as many short-lived instances, and a count kept in one of
// them is not a limit. Each check is a single statement, so two requests
// that arrive together cannot both read the old count.
//
// If the database cannot be asked (no database yet, or a preview deployment
// whose shared database does not have the table), the count is kept in this
// instance's memory instead, which is what the app did before.

export type RateLimitDecision = {
  allowed: boolean;
  /** Requests counted in the current window, this one included. */
  count: number;
  /** Seconds until the current window ends. At least 1 when not allowed. */
  retryAfterSeconds: number;
  /** Where this request was counted, for refundRateLimit. */
  countedIn?: "database" | "memory";
};

type RateLimitInput = {
  key: string;
  limit: number;
  now?: number;
  windowMs: number;
};

type ConsumeRateLimitOptions = {
  database?: DbExecutor;
};

type MemoryEntry = {
  count: number;
  expiresAt: number;
};

declare global {
  var __signudocRateLimitStore: Map<string, MemoryEntry> | undefined;
  var __signudocRateLimitSweepAt: number | undefined;
  var __signudocRateLimitWarnedAt: number | undefined;
}

const memoryStore = (globalThis.__signudocRateLimitStore ??= new Map<
  string,
  MemoryEntry
>());

const MEMORY_SWEEP_INTERVAL_MS = 60 * 1000;
const FALLBACK_WARNING_INTERVAL_MS = 60 * 1000;
// One request in this many also clears out windows that have ended. The
// daily cleanup job does the same, so this only matters where there is none.
const DATABASE_SWEEP_ODDS = 200;

// The key names who is being limited, and for the signing pages that
// includes the signing token. Only a hash of it is stored.
function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function toDecision(
  count: number,
  expiresAt: number,
  input: RateLimitInput,
  now: number,
): RateLimitDecision {
  return {
    allowed: count <= input.limit,
    count,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
  };
}

function sweepMemoryStore(now: number) {
  if ((globalThis.__signudocRateLimitSweepAt ?? 0) > now) {
    return;
  }

  for (const [key, entry] of memoryStore.entries()) {
    if (entry.expiresAt <= now) {
      memoryStore.delete(key);
    }
  }

  globalThis.__signudocRateLimitSweepAt = now + MEMORY_SWEEP_INTERVAL_MS;
}

/** The same counting as the database does, for one instance only. */
export function consumeRateLimitInMemory(
  input: RateLimitInput,
): RateLimitDecision {
  const now = input.now ?? Date.now();

  sweepMemoryStore(now);

  const existing = memoryStore.get(input.key);
  const entry =
    existing && existing.expiresAt > now
      ? { count: existing.count + 1, expiresAt: existing.expiresAt }
      : { count: 1, expiresAt: now + input.windowMs };

  memoryStore.set(input.key, entry);

  return {
    ...toDecision(entry.count, entry.expiresAt, input, now),
    countedIn: "memory",
  };
}

function warnAboutFallback(error: unknown) {
  const now = Date.now();

  if ((globalThis.__signudocRateLimitWarnedAt ?? 0) > now) {
    return;
  }

  globalThis.__signudocRateLimitWarnedAt = now + FALLBACK_WARNING_INTERVAL_MS;
  console.warn(
    "[rate-limit] Counting in memory because the database could not be used:",
    error instanceof Error ? error.message : error,
  );
}

/**
 * Removes windows that have ended. Returns how many rows went. Called by the
 * cleanup job, and now and then by the limiter itself.
 */
export async function deleteExpiredRateLimits(
  database: DbExecutor = getDb(),
  now: number = Date.now(),
): Promise<number> {
  const result = await database.query(
    "delete from public.rate_limits where expires_at <= $1",
    [now],
  );

  return result.rowCount ?? 0;
}

/**
 * Counts one request against a limit and says whether it is within it.
 *
 * Windows are fixed: the first request starts one, and the count resets
 * when it ends. A request over the limit is still counted, but it does not
 * extend the window, so a client that keeps trying is let back in when the
 * window ends rather than never.
 */
export async function consumeRateLimit(
  input: RateLimitInput,
  { database }: ConsumeRateLimitOptions = {},
): Promise<RateLimitDecision> {
  const now = input.now ?? Date.now();

  try {
    const executor = database ?? getDb();
    const result = await executor.query<{
      count: number;
      expires_at: number;
    }>(
      `
        insert into public.rate_limits as current (key, count, expires_at)
        values ($1, 1, $2::bigint + $3::bigint)
        on conflict (key) do update set
          count = case
            when current.expires_at <= $2::bigint or current.count <= 0 then 1
            else least(current.count + 1, 1000000)
          end,
          expires_at = case
            when current.expires_at <= $2::bigint or current.count <= 0
              then $2::bigint + $3::bigint
            else current.expires_at
          end
        returning count, expires_at
      `,
      [hashKey(input.key), now, input.windowMs],
    );
    const row = result.rows[0];

    if (!row) {
      throw new Error("The rate limit statement returned no row.");
    }

    if (Math.floor(Math.random() * DATABASE_SWEEP_ODDS) === 0) {
      void deleteExpiredRateLimits(executor, now).catch(() => undefined);
    }

    return {
      ...toDecision(row.count, Number(row.expires_at), input, now),
      countedIn: "database",
    };
  } catch (error) {
    warnAboutFallback(error);

    return consumeRateLimitInMemory({ ...input, now });
  }
}

type PeekRateLimitInput = Omit<RateLimitInput, "windowMs">;

/**
 * Whether a limit is already used up, without counting anything. For limits
 * that count only some requests (failed sign-ins), checked before each one.
 */
export async function peekRateLimit(
  input: PeekRateLimitInput,
  { database }: ConsumeRateLimitOptions = {},
): Promise<RateLimitDecision> {
  const now = input.now ?? Date.now();
  let entry: MemoryEntry | undefined;

  try {
    const result = await (database ?? getDb()).query<{
      count: number;
      expires_at: number;
    }>(
      "select count, expires_at from public.rate_limits where key = $1 and expires_at > $2",
      [hashKey(input.key), now],
    );
    const row = result.rows[0];

    entry = row
      ? { count: row.count, expiresAt: Number(row.expires_at) }
      : undefined;
  } catch (error) {
    warnAboutFallback(error);

    const memoryEntry = memoryStore.get(input.key);

    entry =
      memoryEntry && memoryEntry.expiresAt > now ? memoryEntry : undefined;
  }

  if (!entry) {
    return { allowed: true, count: 0, retryAfterSeconds: 1 };
  }

  return {
    allowed: entry.count < input.limit,
    count: entry.count,
    retryAfterSeconds: Math.max(1, Math.ceil((entry.expiresAt - now) / 1000)),
  };
}

/**
 * Takes back one request counted by consumeRateLimit, for limits that
 * count every attempt up front (so parallel ones cannot all pass a peek)
 * but only mean to keep the ones that fail. A count that drops to nothing
 * starts a new window with the next request, as if it had never been.
 */
export async function refundRateLimit(
  key: string,
  counted: Pick<RateLimitDecision, "countedIn">,
  {
    database,
    now = Date.now(),
  }: ConsumeRateLimitOptions & { now?: number } = {},
): Promise<void> {
  // Taken back where it was counted: a count kept in memory while the
  // database could not be asked is not in the database, and the other way.
  if (counted.countedIn === "memory") {
    const entry = memoryStore.get(key);

    if (entry && entry.count <= 1) {
      memoryStore.delete(key);
    } else if (entry && entry.expiresAt > now) {
      entry.count -= 1;
    }

    return;
  }

  // One statement, so refunds that arrive together each take one off:
  // the row's lock puts them in turn. A count of zero is left in place;
  // consumeRateLimit treats it as no window at all. If the database cannot
  // be asked now, the try stays counted: a limit that is too strict for a
  // while is safer than one that forgets.
  try {
    await (database ?? getDb()).query(
      "update public.rate_limits set count = greatest(count - 1, 0) where key = $1 and expires_at > $2",
      [hashKey(key), now],
    );
  } catch (error) {
    warnAboutFallback(error);
  }
}

/** Forgets a limit's count, as after a sign-in that worked. */
export async function clearRateLimit(
  key: string,
  { database }: ConsumeRateLimitOptions = {},
): Promise<void> {
  memoryStore.delete(key);

  try {
    await (database ?? getDb()).query(
      "delete from public.rate_limits where key = $1",
      [hashKey(key)],
    );
  } catch (error) {
    warnAboutFallback(error);
  }
}

export function clearRateLimitStoreForTests() {
  memoryStore.clear();
  globalThis.__signudocRateLimitSweepAt = undefined;
  globalThis.__signudocRateLimitWarnedAt = undefined;
}
