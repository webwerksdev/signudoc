import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbExecutor,
  type DbPool,
} from "./db/connection.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";

// API keys for the public API. An administrator creates one in Settings,
// sees it once, and from then on it acts as that administrator. Only a
// hash of the key is stored. See db/migrations/20261118090000_api_keys.sql.

export const API_KEY_PREFIX = "sdk_";
export const MAX_API_KEYS_PER_USER = 25;
export const API_KEY_SCOPES = ["read", "write"] as const;
export const API_KEY_EXPIRY_DAYS = [30, 90, 365] as const;

/** How much of a key is kept in the clear to tell keys apart. */
const DISPLAY_PREFIX_LENGTH = 12;
/** last_used_at is written at most this often. */
const LAST_USED_WRITE_INTERVAL_SECONDS = 60;
const DAY_IN_SECONDS = 24 * 60 * 60;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export class ApiKeyError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ApiKeyError";
    this.statusCode = statusCode;
  }
}

export type ApiKeySummary = {
  createdAt: number;
  expiresAt: number | null;
  id: string;
  lastUsedAt: number | null;
  name: string;
  /**
   * Whether the owner has asked to close their account. Their keys are
   * turned away from then on and are deleted with the account.
   */
  ownerClosing: boolean;
  ownerEmail: string;
  ownerName: string;
  prefix: string;
  revokedAt: number | null;
  scope: ApiKeyScope;
  userId: string;
};

export type ApiKeyPrincipal = {
  apiKey: {
    id: string;
    name: string;
    scope: ApiKeyScope;
  };
  user: {
    email: string;
    id: string;
    name: string;
  };
};

type Actor = {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

const SUMMARY_COLUMNS = `
  k.id,
  k.user_id AS "userId",
  k.name,
  k.prefix,
  k.scope,
  k.created_at AS "createdAt",
  k.last_used_at AS "lastUsedAt",
  k.expires_at AS "expiresAt",
  k.revoked_at AS "revokedAt",
  u.email AS "ownerEmail",
  u.name AS "ownerName",
  EXISTS (
    SELECT 1 FROM account_closure_requests c WHERE c.user_id = k.user_id
  ) AS "ownerClosing"
`;

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new key: the fixed prefix, then 32 random bytes. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/**
 * Whether a string has the shape of one of our keys. Checked before the
 * database is asked, so stray headers cost nothing.
 */
export function looksLikeApiKey(value: string): boolean {
  return /^sdk_[A-Za-z0-9_-]{43}$/.test(value);
}

/**
 * The key from an `Authorization: Bearer …` header, or null. The scheme is
 * matched without regard to case, as HTTP asks.
 */
export function readBearerToken(headers: Headers): string | null {
  const header = headers.get("authorization");

  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);

  return match?.[1] ?? null;
}

export function parseApiKeyScope(value: unknown): ApiKeyScope | null {
  return value === "read" || value === "write" ? value : null;
}

export function scopeAllows(granted: ApiKeyScope, needed: ApiKeyScope) {
  return granted === "write" || needed === "read";
}

export function parseApiKeyName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const name = value.trim().replace(/\s+/g, " ");

  return name.length >= 1 && name.length <= 80 ? name : null;
}

/** 30, 90 or 365 days, or null for a key that does not expire. */
export function parseApiKeyExpiry(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "never") {
    return null;
  }

  const days = typeof value === "string" ? Number(value) : value;

  return (API_KEY_EXPIRY_DAYS as readonly unknown[]).includes(days)
    ? (days as number)
    : undefined;
}

function isAdminRow(row: { role: string } | null): boolean {
  return row?.role === "admin";
}

/**
 * Creates a key for the administrator `actor`. Returns the key itself, which
 * is never stored and cannot be shown again, and its summary.
 */
export async function createApiKey(
  actor: Actor,
  input: { expiresInDays: number | null; name: string; scope: ApiKeyScope },
  database: DbPool = getDb(),
): Promise<{ key: string; summary: ApiKeySummary }> {
  const key = generateApiKey();
  const createdAt = nowInSeconds();
  const id = randomUUID();
  const expiresAt =
    input.expiresInDays === null
      ? null
      : createdAt + input.expiresInDays * DAY_IN_SECONDS;

  // The summary is read in the same transaction, so a failed read undoes
  // the key instead of leaving one live whose secret was never shown.
  const summary = await withTransaction(async (tx) => {
    // Held while counting, so two requests at once cannot both slip under
    // the limit, and while the role is checked, so a removal that lands at
    // the same moment is seen.
    const owner = await queryOne<{ role: string }>(
      tx,
      `SELECT role FROM "user" WHERE id = $1 FOR UPDATE`,
      [actor.userId],
    );

    if (!isAdminRow(owner)) {
      throw new ApiKeyError("Only an administrator can do this.", 403);
    }

    const active = await queryOne<{ count: number }>(
      tx,
      `
        SELECT count(*)::int AS count
        FROM api_keys
        WHERE user_id = $1
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > $2)
      `,
      [actor.userId, createdAt],
    );

    if ((active?.count ?? 0) >= MAX_API_KEYS_PER_USER) {
      throw new ApiKeyError(
        `You can have up to ${String(MAX_API_KEYS_PER_USER)} keys. Revoke one you no longer use first.`,
        409,
      );
    }

    await tx.query(
      `
        INSERT INTO api_keys (
          id, user_id, name, prefix, key_hash, scope, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        id,
        actor.userId,
        input.name,
        key.slice(0, DISPLAY_PREFIX_LENGTH),
        hashApiKey(key),
        input.scope,
        createdAt,
        expiresAt,
      ],
    );
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt,
        event: "api_key_created",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          apiKeyId: id,
          expiresAt,
          name: input.name,
          prefix: key.slice(0, DISPLAY_PREFIX_LENGTH),
          scope: input.scope,
        },
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );

    const created = await getApiKeySummary(id, tx);

    if (!created) {
      throw new Error("A key that was just created could not be read back.");
    }

    return created;
  }, database);

  return { key, summary };
}

async function getApiKeySummary(
  id: string,
  database: DbExecutor,
): Promise<ApiKeySummary | null> {
  return queryOne<ApiKeySummary>(
    database,
    `
      SELECT ${SUMMARY_COLUMNS}
      FROM api_keys k
      JOIN "user" u ON u.id = k.user_id
      WHERE k.id = $1
    `,
    [id],
  );
}

/** How many revoked keys Settings still lists, newest first. */
export const LISTED_REVOKED_API_KEYS = 50;

/**
 * Every key on the install that is not revoked (expired ones too, so none
 * that could still matter is ever out of sight), newest first, then the
 * most recently revoked. Administrators manage each other's keys, since a
 * key acts for the organization.
 */
export async function listApiKeys(
  database: DbExecutor = getDb(),
): Promise<ApiKeySummary[]> {
  // One statement, so both groups come from the same moment: a key revoked
  // while the list is read shows once, not as both working and revoked.
  return queryMany<ApiKeySummary>(
    database,
    `
      WITH listed AS (
        SELECT id, 0 AS list_group, created_at AS sorted_by
        FROM api_keys
        WHERE revoked_at IS NULL
        UNION ALL
        (
          SELECT id, 1 AS list_group, revoked_at AS sorted_by
          FROM api_keys
          WHERE revoked_at IS NOT NULL
          ORDER BY revoked_at DESC, id
          LIMIT $1
        )
      )
      SELECT ${SUMMARY_COLUMNS}
      FROM listed l
      JOIN api_keys k ON k.id = l.id
      JOIN "user" u ON u.id = k.user_id
      ORDER BY l.list_group, l.sorted_by DESC, k.id
    `,
    [LISTED_REVOKED_API_KEYS],
  );
}

/** Revokes a key for the administrator `actor`. Revoking twice is fine. */
export async function revokeApiKey(
  actor: Actor,
  keyId: string,
  database: DbPool = getDb(),
): Promise<ApiKeySummary> {
  const revokedAt = nowInSeconds();

  await withTransaction(async (tx) => {
    // Held until the revocation commits, as when a key is made, so a
    // removal of the actor's role that lands at the same moment either
    // waits for it or is seen here. The user row comes before the key row
    // and the audit chain, the order a role change takes them in too.
    const owner = await queryOne<{ role: string }>(
      tx,
      `SELECT role FROM "user" WHERE id = $1 FOR UPDATE`,
      [actor.userId],
    );

    if (!isAdminRow(owner)) {
      throw new ApiKeyError("Only an administrator can do this.", 403);
    }

    const key = await queryOne<{
      name: string;
      prefix: string;
      revokedAt: number | null;
      userId: string;
    }>(
      tx,
      `
        SELECT name, prefix, user_id AS "userId", revoked_at AS "revokedAt"
        FROM api_keys
        WHERE id = $1
        FOR UPDATE
      `,
      [keyId],
    );

    if (!key) {
      throw new ApiKeyError("That key no longer exists.", 404);
    }

    if (key.revokedAt !== null) {
      return;
    }

    await tx.query(`UPDATE api_keys SET revoked_at = $1 WHERE id = $2`, [
      revokedAt,
      keyId,
    ]);
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt: revokedAt,
        event: "api_key_revoked",
        ipAddress: actor.ipAddress ?? null,
        metadata: {
          apiKeyId: keyId,
          name: key.name,
          prefix: key.prefix,
          reason: "revoked",
        },
        targetUserId: key.userId,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);

  const summary = await getApiKeySummary(keyId, database);

  if (!summary) {
    throw new ApiKeyError("That key no longer exists.", 404);
  }

  return summary;
}

/**
 * Revokes every key an account still has, inside the caller's transaction.
 * Called when the account stops being an administrator, so that making it
 * one again later does not quietly bring old keys back.
 */
export async function revokeApiKeysForUser(
  userId: string,
  reason: string,
  tx: DbExecutor,
  actor: { email: string | null; userId: string | null } = {
    email: null,
    userId: null,
  },
): Promise<number> {
  const revokedAt = nowInSeconds();
  const revoked = await tx.query<{ id: string; name: string; prefix: string }>(
    `
      UPDATE api_keys
      SET revoked_at = $1
      WHERE user_id = $2 AND revoked_at IS NULL
      RETURNING id, name, prefix
    `,
    [revokedAt, userId],
  );

  for (const key of revoked.rows) {
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        createdAt: revokedAt,
        event: "api_key_revoked",
        metadata: {
          apiKeyId: key.id,
          name: key.name,
          prefix: key.prefix,
          reason,
        },
        targetUserId: userId,
      },
      tx,
    );
  }

  return revoked.rowCount ?? 0;
}

/**
 * The account a presented key acts as, or null if the key is unknown,
 * revoked, expired, or belongs to someone who is no longer an
 * administrator or is closing their account. Every one of those looks the
 * same to the caller.
 */
export async function authenticateApiKey(
  presented: string,
  database: DbExecutor = getDb(),
  now: number = nowInSeconds(),
): Promise<ApiKeyPrincipal | null> {
  if (!looksLikeApiKey(presented)) {
    return null;
  }

  const presentedHash = hashApiKey(presented);
  const row = await queryOne<{
    email: string;
    emailVerified: boolean;
    id: string;
    keyHash: string;
    lastUsedAt: number | null;
    name: string;
    role: string;
    scope: ApiKeyScope;
    userId: string;
    userName: string;
  }>(
    database,
    `
      SELECT
        k.id,
        k.name,
        k.scope,
        k.key_hash AS "keyHash",
        k.last_used_at AS "lastUsedAt",
        u.id AS "userId",
        u.email,
        u.name AS "userName",
        u.role,
        u."emailVerified" AS "emailVerified"
      FROM api_keys k
      JOIN "user" u ON u.id = k.user_id
      WHERE k.key_hash = $1
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > $2)
        AND NOT EXISTS (
          SELECT 1 FROM account_closure_requests c WHERE c.user_id = u.id
        )
    `,
    [presentedHash, now],
  );

  if (
    !row ||
    row.role !== "admin" ||
    row.emailVerified !== true ||
    // The lookup was by hash already; this only guards against a database
    // that compares text loosely.
    !timingSafeEqual(Buffer.from(row.keyHash), Buffer.from(presentedHash))
  ) {
    return null;
  }

  if (
    row.lastUsedAt === null ||
    now - row.lastUsedAt >= LAST_USED_WRITE_INTERVAL_SECONDS
  ) {
    // The interval is checked again against the row as it is now, so
    // requests at the same moment write once and an older time never
    // replaces a newer one. The casts are needed: Postgres reads the WHERE
    // first and cannot subtract two parameters of unknown type.
    await database
      .query(
        `
          UPDATE api_keys SET last_used_at = $1::bigint
          WHERE id = $2
            AND (last_used_at IS NULL OR last_used_at <= $1::bigint - $3::bigint)
        `,
        [now, row.id, LAST_USED_WRITE_INTERVAL_SECONDS],
      )
      .catch((error: unknown) => {
        console.error("Recording when an API key was used failed:", error);
      });
  }

  return {
    apiKey: { id: row.id, name: row.name, scope: row.scope },
    user: { email: row.email, id: row.userId, name: row.userName },
  };
}
