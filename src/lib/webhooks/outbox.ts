import { afterCommit, type DbExecutor } from "../db/connection.ts";
import type { AuditEventType } from "../types/domain.ts";
import { scheduleWebhookDrain } from "./deliver.ts";
import { webhookEventForAuditEvent } from "./events.ts";

// The outbox: recordAuditEvent calls this with the transaction it writes
// the audit row in, so a delivery exists exactly when its event does. The
// payload is built later, by the first try, from the envelope as it stands
// after the commit (see deliver.ts).
//
// On an install without webhook endpoints this is one INSERT ... SELECT
// over an empty table, which costs nothing worth measuring.

type DrainScheduler = () => void;

let drainScheduler: DrainScheduler = scheduleWebhookDrain;

/**
 * Who starts sending once new deliveries have committed. Tests replace it
 * to send on their own terms; null puts the default back.
 */
export function setWebhookDrainScheduler(scheduler: DrainScheduler | null) {
  drainScheduler = scheduler ?? scheduleWebhookDrain;
}

/** Starts sending what is due, after the response. */
export function requestWebhookDrain() {
  drainScheduler();
}

/**
 * How long an envelope.sent delivery waits, unclaimable, for its
 * invitation email. sendDraftEnvelope releases it the moment the email is
 * out, or deletes it if the email fails and the send is undone. The wait
 * only runs out if the function died in between, and then the envelope
 * did stay sent, so the delivery is right to go.
 */
export const SENT_HOLD_SECONDS = 10 * 60;

/**
 * Makes an envelope's held envelope.sent delivery due now and starts
 * sending. Called once the envelope is really out.
 */
export async function releaseSentWebhook(
  envelopeId: string,
  database: DbExecutor,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  await database.query(
    `
      UPDATE webhook_deliveries
      SET next_attempt_at = $2, updated_at = $2
      WHERE envelope_id = $1 AND event_type = 'envelope.sent'
        AND status = 'pending' AND attempts = 0 AND next_attempt_at > $2
    `,
    [envelopeId, now],
  );
  drainScheduler();
}

export async function enqueueWebhookDeliveries(
  input: {
    auditEventId: string;
    createdAt: number;
    envelopeId: string;
    event: AuditEventType;
    metadata: Record<string, unknown> | null;
  },
  database: DbExecutor,
): Promise<number> {
  const type = webhookEventForAuditEvent(input.event);

  if (!type) {
    return 0;
  }

  const signerId =
    typeof input.metadata?.signerId === "string"
      ? input.metadata.signerId
      : null;
  const now = Math.floor(Date.now() / 1000);
  // Due now. The audit event's own time can be a second ahead, since
  // events on one envelope never share a second. A send is not finished
  // until its invitation email is out, so its delivery waits for that
  // (see SENT_HOLD_SECONDS) and no drain can take it early.
  const dueAt =
    input.event === "sent"
      ? now + SENT_HOLD_SECONDS
      : Math.min(input.createdAt, now);
  const result = await database.query(
    `
      INSERT INTO webhook_deliveries (
        id, endpoint_id, event_type, envelope_id, audit_event_id, signer_id,
        status, attempts, next_attempt_at, created_at, updated_at
      )
      SELECT
        'msg_' || replace(gen_random_uuid()::text, '-', ''),
        id, $1, $2, $3, $4, 'pending', 0, $5, $6, $6
      FROM webhook_endpoints
      WHERE enabled AND $1 = ANY(events)
      -- An endpoint being removed at this moment is waited for and then
      -- skipped, instead of failing this envelope's change on the foreign
      -- key once the removal commits. The lock also keeps a matching
      -- endpoint until this transaction ends.
      FOR KEY SHARE
    `,
    [
      type,
      input.envelopeId,
      input.auditEventId,
      signerId,
      dueAt,
      Math.min(input.createdAt, now),
    ],
  );
  const queued = result.rowCount ?? 0;

  // sendDraftEnvelope releases a send's delivery once the email is out.
  if (queued > 0 && input.event !== "sent") {
    afterCommit(database, () => {
      drainScheduler();
    });
  }

  return queued;
}
