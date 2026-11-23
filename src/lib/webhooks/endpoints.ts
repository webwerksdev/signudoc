import { randomUUID } from "node:crypto";

import {
  getDb,
  queryMany,
  queryOne,
  withTransaction,
  type DbExecutor,
  type DbPool,
} from "../db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../services/seal-identity.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";
import type { EnvSource } from "../utils/env.ts";
import { type WebhookEventType } from "./events.ts";
import { parseWebhookUrl, WebhookUrlError } from "./safe-post.ts";
import { generateWebhookSecret } from "./signing.ts";

// Webhook endpoints: where the install sends envelope events. They belong
// to the whole install, as the email domain does, so only administrators
// add, change or remove them, and each change is on the install's audit
// trail. The signing secret is shown once, when it is made, and kept
// encrypted.

export const MAX_WEBHOOK_ENDPOINTS = 10;
/** How long the old secret keeps signing after a rotation. */
export const SECRET_ROTATION_OVERLAP_SECONDS = 24 * 60 * 60;

const SECRET_CONTEXT = "signudoc/webhook-secret/v1";

export class WebhookEndpointError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "WebhookEndpointError";
    this.statusCode = statusCode;
  }
}

export type WebhookEndpoint = {
  createdAt: number;
  description: string;
  enabled: boolean;
  events: WebhookEventType[];
  id: string;
  /** When the secret before the last rotation stops signing, or null. */
  previousSecretExpiresAt: number | null;
  updatedAt: number;
  url: string;
};

export type WebhookActor = {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

const ENDPOINT_COLUMNS = `
  id,
  url,
  description,
  events,
  enabled,
  previous_secret_expires_at AS "previousSecretExpiresAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

export function sealWebhookSecret(
  secret: string,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(secret, secretKeyFor(SECRET_CONTEXT, env));
}

export function openWebhookSecret(
  value: string,
  env: EnvSource = process.env,
): string | null {
  return decryptPrivateKey(value, secretKeyFor(SECRET_CONTEXT, env));
}

export function parseWebhookDescription(value: unknown): string | null {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    return null;
  }

  const description = value.trim().replace(/\s+/g, " ");

  return description.length <= 200 ? description : null;
}

async function requireAdmin(actor: WebhookActor, tx: DbExecutor) {
  // Locked, so a role removal that lands at the same moment is seen.
  const row = await queryOne<{ role: string }>(
    tx,
    `SELECT role FROM "user" WHERE id = $1 FOR UPDATE`,
    [actor.userId],
  );

  if (row?.role !== "admin") {
    throw new WebhookEndpointError("Only an administrator can do this.", 403);
  }
}

function auditFields(actor: WebhookActor) {
  return {
    actorEmail: actor.email,
    actorUserId: actor.userId,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  };
}

function checkedUrl(value: unknown, env: EnvSource): string {
  try {
    return parseWebhookUrl(value, env).toString();
  } catch (error) {
    if (error instanceof WebhookUrlError) {
      throw new WebhookEndpointError(error.message, 400);
    }

    throw error;
  }
}

export async function listWebhookEndpoints(
  database: DbExecutor = getDb(),
): Promise<WebhookEndpoint[]> {
  return queryMany<WebhookEndpoint>(
    database,
    `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints ORDER BY created_at, id`,
  );
}

export async function getWebhookEndpoint(
  id: string,
  database: DbExecutor = getDb(),
): Promise<WebhookEndpoint | null> {
  return queryOne<WebhookEndpoint>(
    database,
    `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = $1`,
    [id],
  );
}

/** Adds an endpoint. Returns its secret, which is never shown again. */
export async function createWebhookEndpoint(
  actor: WebhookActor,
  input: { description: string; events: WebhookEventType[]; url: unknown },
  options: { database?: DbPool; env?: EnvSource } = {},
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const env = options.env ?? process.env;
  const url = checkedUrl(input.url, env);
  const secret = generateWebhookSecret();
  const id = `we_${randomUUID().replaceAll("-", "")}`;
  const createdAt = nowInSeconds();

  const endpoint = await withTransaction(async (tx) => {
    await requireAdmin(actor, tx);
    // One at a time, so two requests cannot both slip under the limit.
    await tx.query(`LOCK TABLE webhook_endpoints IN SHARE ROW EXCLUSIVE MODE`);

    const count = await queryOne<{ count: number }>(
      tx,
      `SELECT count(*)::int AS count FROM webhook_endpoints`,
    );

    if ((count?.count ?? 0) >= MAX_WEBHOOK_ENDPOINTS) {
      throw new WebhookEndpointError(
        `An install can have up to ${String(MAX_WEBHOOK_ENDPOINTS)} webhook endpoints. Remove one first.`,
        409,
      );
    }

    const created = await queryOne<WebhookEndpoint>(
      tx,
      `
        INSERT INTO webhook_endpoints (
          id, url, description, secret_encrypted, events, enabled,
          created_by, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, true, $6, $7, $7)
        RETURNING ${ENDPOINT_COLUMNS}
      `,
      [
        id,
        url,
        input.description,
        sealWebhookSecret(secret, env),
        input.events,
        actor.userId,
        createdAt,
      ],
    );

    await recordSystemAuditEvent(
      {
        ...auditFields(actor),
        createdAt,
        event: "webhook_endpoint_created",
        metadata: { endpointId: id, events: input.events, url },
      },
      tx,
    );

    return created!;
  }, options.database ?? getDb());

  return { endpoint, secret };
}

/** Changes an endpoint's URL, events, description or whether it is on. */
export async function updateWebhookEndpoint(
  actor: WebhookActor,
  id: string,
  input: {
    description?: string;
    enabled?: boolean;
    events?: WebhookEventType[];
    url?: unknown;
  },
  options: { database?: DbPool; env?: EnvSource } = {},
): Promise<WebhookEndpoint> {
  const env = options.env ?? process.env;
  const url = input.url === undefined ? undefined : checkedUrl(input.url, env);
  const updatedAt = nowInSeconds();

  return withTransaction(async (tx) => {
    await requireAdmin(actor, tx);

    const before = await queryOne<WebhookEndpoint>(
      tx,
      `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (!before) {
      throw new WebhookEndpointError("That endpoint does not exist.", 404);
    }

    const after = await queryOne<WebhookEndpoint>(
      tx,
      `
        UPDATE webhook_endpoints
        SET url = $2, description = $3, events = $4, enabled = $5, updated_at = $6
        WHERE id = $1
        RETURNING ${ENDPOINT_COLUMNS}
      `,
      [
        id,
        url ?? before.url,
        input.description ?? before.description,
        input.events ?? before.events,
        input.enabled ?? before.enabled,
        updatedAt,
      ],
    );
    const changed: Record<string, unknown> = {};

    for (const key of ["url", "description", "enabled"] as const) {
      if (after![key] !== before[key]) {
        changed[key] = after![key];
      }
    }

    if (after!.events.join(",") !== before.events.join(",")) {
      changed.events = after!.events;
    }

    if (Object.keys(changed).length > 0) {
      await recordSystemAuditEvent(
        {
          ...auditFields(actor),
          createdAt: updatedAt,
          event: "webhook_endpoint_changed",
          metadata: { endpointId: id, url: after!.url, ...changed },
        },
        tx,
      );
    }

    return after!;
  }, options.database ?? getDb());
}

/**
 * Makes a new secret. The old one keeps signing for a day as well, so a
 * receiver can switch without dropping deliveries. Refused while an
 * earlier switch-over is still running: a second new secret would drop
 * the old one before its day was up, and receivers still on it would
 * start refusing deliveries.
 */
export async function rotateWebhookSecret(
  actor: WebhookActor,
  id: string,
  options: { database?: DbPool; env?: EnvSource } = {},
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const env = options.env ?? process.env;
  const secret = generateWebhookSecret();
  const rotatedAt = nowInSeconds();

  return withTransaction(async (tx) => {
    await requireAdmin(actor, tx);

    const endpoint = await queryOne<WebhookEndpoint>(
      tx,
      `
        UPDATE webhook_endpoints
        SET previous_secret_encrypted = secret_encrypted,
            previous_secret_expires_at = $2,
            secret_encrypted = $3,
            updated_at = $4
        WHERE id = $1
          AND (previous_secret_expires_at IS NULL
            OR previous_secret_expires_at <= $4)
        RETURNING ${ENDPOINT_COLUMNS}
      `,
      [
        id,
        rotatedAt + SECRET_ROTATION_OVERLAP_SECONDS,
        sealWebhookSecret(secret, env),
        rotatedAt,
      ],
    );

    if (!endpoint) {
      // Two rotations at once queue on the row, and the second then sees
      // the first one's switch-over here.
      const existing = await queryOne<{ previousSecretExpiresAt: number }>(
        tx,
        `
          SELECT previous_secret_expires_at AS "previousSecretExpiresAt"
          FROM webhook_endpoints WHERE id = $1
        `,
        [id],
      );

      if (!existing) {
        throw new WebhookEndpointError("That endpoint does not exist.", 404);
      }

      throw new WebhookEndpointError(
        `This endpoint's old secret still signs until ${new Date(existing.previousSecretExpiresAt * 1000).toISOString()}, so receivers can switch. Make another new secret after that, or remove the endpoint and add it again to replace its secret now.`,
        409,
      );
    }

    await recordSystemAuditEvent(
      {
        ...auditFields(actor),
        createdAt: rotatedAt,
        event: "webhook_endpoint_changed",
        metadata: { endpointId: id, secretRotated: true, url: endpoint.url },
      },
      tx,
    );

    return { endpoint, secret };
  }, options.database ?? getDb());
}

/** Removes an endpoint and its delivery log. */
export async function deleteWebhookEndpoint(
  actor: WebhookActor,
  id: string,
  database: DbPool = getDb(),
): Promise<void> {
  await withTransaction(async (tx) => {
    await requireAdmin(actor, tx);

    const removed = await queryOne<{ url: string }>(
      tx,
      `DELETE FROM webhook_endpoints WHERE id = $1 RETURNING url`,
      [id],
    );

    if (!removed) {
      throw new WebhookEndpointError("That endpoint does not exist.", 404);
    }

    await recordSystemAuditEvent(
      {
        ...auditFields(actor),
        event: "webhook_endpoint_deleted",
        metadata: { endpointId: id, url: removed.url },
      },
      tx,
    );
  }, database);
}

/**
 * The secrets that sign a delivery now: the current one, and the one
 * before it while the rotation overlap lasts. Empty when the auth secret
 * changed and they can no longer be read.
 */
export function signingSecretsFor(
  row: {
    previousSecretEncrypted: string | null;
    previousSecretExpiresAt: number | null;
    secretEncrypted: string;
  },
  now: number,
  env: EnvSource = process.env,
): string[] {
  const secrets: string[] = [];
  const current = openWebhookSecret(row.secretEncrypted, env);

  if (current) {
    secrets.push(current);
  }

  if (
    row.previousSecretEncrypted &&
    row.previousSecretExpiresAt !== null &&
    row.previousSecretExpiresAt > now
  ) {
    const previous = openWebhookSecret(row.previousSecretEncrypted, env);

    if (previous) {
      secrets.push(previous);
    }
  }

  return secrets;
}
