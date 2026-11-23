import {
  getDb,
  queryMany,
  queryOne,
  type DbExecutor,
} from "../db/connection.ts";
import { isoTime } from "../api/envelope-view.ts";

// The delivery log: what Settings shows per endpoint, what the API's
// catch-up list returns, "Send again", and the daily cleanup.

/** Delivered rows are kept this long, failed ones longer for looking into. */
export const DELIVERED_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const FAILED_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const MAX_LOG_ROWS = 100;

export type WebhookDeliverySummary = {
  attempts: number;
  createdAt: number;
  deliveredAt: number | null;
  endpointId: string;
  envelopeId: string | null;
  eventType: string;
  id: string;
  lastError: string | null;
  lastStatusCode: number | null;
  nextAttemptAt: number | null;
  status: "delivered" | "failed" | "pending";
};

const SUMMARY_COLUMNS = `
  id,
  endpoint_id AS "endpointId",
  event_type AS "eventType",
  envelope_id AS "envelopeId",
  status,
  attempts,
  next_attempt_at AS "nextAttemptAt",
  last_status_code AS "lastStatusCode",
  last_error AS "lastError",
  created_at AS "createdAt",
  delivered_at AS "deliveredAt"
`;

/** The newest deliveries to one endpoint. */
export async function listEndpointDeliveries(
  endpointId: string,
  database: DbExecutor = getDb(),
): Promise<WebhookDeliverySummary[]> {
  return queryMany<WebhookDeliverySummary>(
    database,
    `
      SELECT ${SUMMARY_COLUMNS}
      FROM webhook_deliveries
      WHERE endpoint_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
    `,
    [endpointId, MAX_LOG_ROWS],
  );
}

/**
 * Puts a delivery back in line to be sent now, with a full set of tries.
 * What its last try got is cleared, so it no longer reads as delivered.
 * False when there is no such delivery or it is being sent this moment.
 */
export async function resendWebhookDelivery(
  id: string,
  database: DbExecutor = getDb(),
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const result = await database.query(
    `
      UPDATE webhook_deliveries
      SET status = 'pending', attempts = 0, next_attempt_at = $2,
          locked_until = NULL, delivered_at = NULL, last_status_code = NULL,
          last_error = NULL, updated_at = $2
      WHERE id = $1 AND (locked_until IS NULL OR locked_until <= $2)
    `,
    [id, now],
  );

  return (result.rowCount ?? 0) === 1;
}

export type ApiWebhookDelivery = {
  attempts: number;
  createdAt: string;
  deliveredAt: string | null;
  endpointId: string;
  envelopeId: string | null;
  id: string;
  lastStatusCode: number | null;
  object: "webhook_delivery";
  payload: unknown;
  status: "delivered" | "failed" | "pending";
  type: string;
};

function encodeCursor(createdAt: number, id: string) {
  return Buffer.from(`${String(createdAt)}:${id}`, "utf8").toString(
    "base64url",
  );
}

function decodeCursor(
  cursor: string,
): { createdAt: number; id: string } | null {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf(":");
  const createdAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);

  return separator > 0 &&
    Number.isSafeInteger(createdAt) &&
    createdAt >= 0 &&
    id.startsWith("msg_")
    ? { createdAt, id }
    : null;
}

/**
 * Deliveries for the API, newest first, for an app that wants to catch up
 * on what it missed. Envelope events only: tests are left out. Null for a
 * cursor this API did not give out.
 */
export async function listApiWebhookDeliveries(
  query: {
    cursor?: string;
    limit: number;
    since?: number;
    status?: "delivered" | "failed" | "pending";
    type?: string;
  },
  database: DbExecutor = getDb(),
): Promise<{ data: ApiWebhookDelivery[]; nextCursor: string | null } | null> {
  const after = query.cursor ? decodeCursor(query.cursor) : null;

  if (query.cursor && !after) {
    return null;
  }

  const rows = await queryMany<
    WebhookDeliverySummary & { payload: string | null }
  >(
    database,
    `
      SELECT ${SUMMARY_COLUMNS}, payload
      FROM webhook_deliveries
      WHERE event_type <> 'webhook.test'
        AND ($1::bigint IS NULL OR created_at >= $1)
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR event_type = $3)
        AND ($4::bigint IS NULL OR (created_at, id) < ($4, $5::text))
      ORDER BY created_at DESC, id DESC
      LIMIT $6
    `,
    [
      query.since ?? null,
      query.status ?? null,
      query.type ?? null,
      after?.createdAt ?? null,
      after?.id ?? null,
      query.limit + 1,
    ],
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);

  return {
    data: page.map((row) => ({
      attempts: row.attempts,
      createdAt: isoTime(row.createdAt) ?? new Date(0).toISOString(),
      deliveredAt: isoTime(row.deliveredAt),
      endpointId: row.endpointId,
      envelopeId: row.envelopeId,
      id: row.id,
      lastStatusCode: row.lastStatusCode,
      object: "webhook_delivery",
      payload:
        row.payload === null ? null : (JSON.parse(row.payload) as unknown),
      status: row.status,
      type: row.eventType,
    })),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor(last.createdAt, last.id)
        : null,
  };
}

/**
 * For the daily cleanup. A delivered one goes 30 days after it was
 * delivered, any other 90 days after it last changed, so one put back in
 * line with "Send again" keeps its retries however old its event is.
 */
export async function deleteOldWebhookDeliveries(
  database: DbExecutor = getDb(),
  now: number = Math.floor(Date.now() / 1000),
): Promise<number> {
  const result = await database.query(
    `
      DELETE FROM webhook_deliveries
      WHERE (status = 'delivered'
             AND COALESCE(delivered_at, created_at) <= $1)
         OR (status <> 'delivered' AND updated_at <= $2)
    `,
    [now - DELIVERED_RETENTION_SECONDS, now - FAILED_RETENTION_SECONDS],
  );

  return result.rowCount ?? 0;
}

export async function getWebhookDeliveryEndpointId(
  id: string,
  database: DbExecutor = getDb(),
): Promise<string | null> {
  const row = await queryOne<{ endpointId: string }>(
    database,
    `SELECT endpoint_id AS "endpointId" FROM webhook_deliveries WHERE id = $1`,
    [id],
  );

  return row?.endpointId ?? null;
}
