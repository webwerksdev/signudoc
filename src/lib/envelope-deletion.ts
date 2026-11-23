import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { EnvelopeMutationError } from "./envelopes.ts";
import {
  deletePendingFile,
  listEnvelopeStorageKeys,
  queueFileDeletions,
} from "./retention.ts";
import { createEmailService, type EmailService } from "./services/email.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { resolveAppUrl } from "./utils/env.ts";

// An administrator may delete any finished envelope, their own or another
// member's, but not at once. Asking schedules it: the envelope stays as it
// is for ENVELOPE_DELETION_WAIT_DAYS, its sender is emailed a link to
// download it, and any administrator can cancel until then. The daily
// cleanup then deletes the signed PDF, the certificates, the fields and the
// envelope's own audit trail, as the retention period does. Asking,
// cancelling and the deletion itself all stay in the install's audit
// trail, the last with the fingerprints the certificate gave.

const FINISHED_STATUSES = ["completed", "declined", "voided"] as const;

export const ENVELOPE_DELETION_REASON_MAX_LENGTH = 1000;

/** How long a scheduled deletion waits, so it can be cancelled. */
export const ENVELOPE_DELETION_WAIT_DAYS = 14;

const DAY_IN_SECONDS = 24 * 60 * 60;

/** How many due deletions, and sender notices, one daily run handles. */
export const SCHEDULED_DELETIONS_PER_RUN = 100;

type FinishedEnvelopeRow = {
  evidenceSha256: string | null;
  finishedAt: number | null;
  id: string;
  ownerUserId: string;
  part11: boolean;
  recipientEvidenceSha256: string | null;
  signedPdfSha256: string | null;
  sourcePdfHash: string;
  status: string;
  title: string;
};

type OwnerRow = { email: string; name: string | null; role: string };

type ScheduleRow = {
  deleteAfter: number;
  reason: string | null;
  requestedAt: number;
  requestedByEmail: string;
  requestedByUserId: string;
  senderNotifiedAt: number | null;
  cancelledAt: number | null;
  cancelledByEmail: string | null;
  cancelledByUserId: string | null;
  cancelNotifiedAt: number | null;
};

export type ScheduledEnvelopeDeletion = {
  deleteAfter: number;
  reason: string | null;
  requestedAt: number;
  requestedByEmail: string;
};

export type EnvelopeDeletionRequest = {
  actor: { email: string; userId: string };
  ipAddress?: string | null;
  reason?: unknown;
  userAgent?: string | null;
};

function currentTime(): number {
  return Math.floor(Date.now() / 1000);
}

function formatDay(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function parseReason(reason: unknown, part11: boolean): string | null {
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    throw new EnvelopeMutationError("The reason must be text.", 400);
  }

  const trimmed = typeof reason === "string" ? reason.trim() : "";

  if (trimmed.length > ENVELOPE_DELETION_REASON_MAX_LENGTH) {
    throw new EnvelopeMutationError(
      `Keep the reason under ${String(ENVELOPE_DELETION_REASON_MAX_LENGTH)} characters.`,
      400,
    );
  }

  if (part11 && trimmed.length === 0) {
    throw new EnvelopeMutationError(
      "Give a reason for deleting this Part 11 record.",
      400,
    );
  }

  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Locks a finished envelope for an administrator, or for the daily cleanup
 * when `actorUserId` is null, in the one order everything here uses.
 *
 * The account rows come before the envelope row: the sender's, then the
 * administrator's. Taking away a role, and closing an account, hold that
 * account's row (FOR UPDATE) before they take the audit trail lock and
 * move its envelopes, so the two wait in turn here instead of each holding
 * what the other needs. Read under these locks, the administrator's role is
 * the one in force: a change since the page loaded is honored. The
 * envelope row comes next, then the install's audit trail lock.
 */
async function lockFinishedEnvelope(
  tx: DbExecutor,
  envelopeId: string,
  actorUserId: string | null,
): Promise<{ envelope: FinishedEnvelopeRow; owner: OwnerRow | null }> {
  // Whose envelope it is, read first without a lock, so that the sender's
  // account row can be taken before the envelope row.
  const located = await queryOne<{ ownerUserId: string }>(
    tx,
    `SELECT user_id AS "ownerUserId" FROM envelopes WHERE id = $1`,
    [envelopeId],
  );

  if (!located) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  const owner = await queryOne<OwnerRow>(
    tx,
    `SELECT email, name, role FROM public."user" WHERE id = $1 FOR SHARE`,
    [located.ownerUserId],
  );
  let actorIsAdmin = true;

  if (actorUserId !== null) {
    const actorIsOwner = located.ownerUserId === actorUserId;
    const actorRole = actorIsOwner
      ? owner
      : await queryOne<{ role: string }>(
          tx,
          `SELECT role FROM public."user" WHERE id = $1 FOR SHARE`,
          [actorUserId],
        );

    actorIsAdmin = actorRole?.role === "admin";

    // Someone else's envelope is not there for anyone but an
    // administrator.
    if (!actorIsOwner && !actorIsAdmin) {
      throw new EnvelopeMutationError("Envelope not found.", 404);
    }
  }

  const envelope = await queryOne<FinishedEnvelopeRow>(
    tx,
    `
      SELECT
        id,
        user_id AS "ownerUserId",
        title,
        status,
        part11,
        source_pdf_hash AS "sourcePdfHash",
        signed_pdf_sha256 AS "signedPdfSha256",
        evidence_sha256 AS "evidenceSha256",
        recipient_evidence_sha256 AS "recipientEvidenceSha256",
        COALESCE(completed_at, declined_at, voided_at) AS "finishedAt"
      FROM envelopes
      WHERE id = $1
      FOR UPDATE
    `,
    [envelopeId],
  );

  if (!envelope) {
    throw new EnvelopeMutationError("Envelope not found.", 404);
  }

  if (envelope.ownerUserId !== located.ownerUserId) {
    // Handed to another administrator in the moment between.
    throw new EnvelopeMutationError(
      "This envelope just moved to another account. Reload the page and try again.",
      409,
    );
  }

  if (!(FINISHED_STATUSES as readonly string[]).includes(envelope.status)) {
    throw new EnvelopeMutationError(
      envelope.status === "sent"
        ? "This envelope is still out for signature. Void it first."
        : "Only finished envelopes can be deleted this way.",
      409,
    );
  }

  if (!actorIsAdmin) {
    throw new EnvelopeMutationError(
      "Only an administrator can delete a finished envelope.",
      403,
    );
  }

  return { envelope, owner };
}

const SCHEDULE_COLUMNS = `
  requested_by_user_id AS "requestedByUserId",
  requested_by_email AS "requestedByEmail",
  requested_at AS "requestedAt",
  delete_after AS "deleteAfter",
  reason,
  sender_notified_at AS "senderNotifiedAt",
  cancelled_at AS "cancelledAt",
  cancelled_by_user_id AS "cancelledByUserId",
  cancelled_by_email AS "cancelledByEmail",
  cancel_notified_at AS "cancelNotifiedAt"
`;

/** The deletion scheduled for an envelope, if there is one. */
export async function getScheduledEnvelopeDeletion(
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<ScheduledEnvelopeDeletion | null> {
  const row = await queryOne<ScheduleRow>(
    database,
    `
      SELECT ${SCHEDULE_COLUMNS}
      FROM scheduled_envelope_deletions
      WHERE envelope_id = $1 AND cancelled_at IS NULL
    `,
    [envelopeId],
  );

  return row
    ? {
        deleteAfter: row.deleteAfter,
        reason: row.reason,
        requestedAt: row.requestedAt,
        requestedByEmail: row.requestedByEmail,
      }
    : null;
}

function envelopeLink(envelopeId: string): string | null {
  const appUrl = resolveAppUrl();

  return appUrl ? `${appUrl}/envelopes/${envelopeId}` : null;
}

type NoticeTarget = {
  envelopeId: string;
  ownerEmail: string;
  ownerName: string | null;
  title: string;
};

function greeting(target: NoticeTarget): string {
  return `Hello ${target.ownerName?.trim() || target.ownerEmail},`;
}

/**
 * Tells the sender that their envelope will be deleted, and when. The
 * sender always gets the whole wait: a notice that goes out late moves the
 * date back to ENVELOPE_DELETION_WAIT_DAYS after it, and nothing is deleted
 * before its notice has gone.
 */
async function sendDeletionNotice(
  target: NoticeTarget & {
    deleteAfter: number;
    requestedAt: number;
    requestedByEmail: string;
  },
  now: number,
  database: DbExecutor,
  emailService: EmailService,
): Promise<void> {
  const deleteOn = Math.max(
    target.deleteAfter,
    now + ENVELOPE_DELETION_WAIT_DAYS * DAY_IN_SECONDS,
  );
  const link = envelopeLink(target.envelopeId);

  await emailService.send(
    {
      subject: `"${target.title}" will be deleted on ${formatDay(deleteOn)}`,
      template: "deletion_notice",
      textBody: [
        greeting(target),
        "",
        `An administrator of your organization (${target.requestedByEmail}) has scheduled "${target.title}" and its audit trail to be deleted on or after ${formatDay(deleteOn)}.`,
        "",
        "Download the signed PDF and the certificate before then if you need to keep them. If this is a mistake, ask an administrator: they can cancel it until that day.",
        ...(link ? ["", link] : []),
      ].join("\n"),
      to: target.ownerEmail,
    },
    {
      idempotencyKey: `deletion-notice/${target.envelopeId}/${String(target.requestedAt)}/${String(deleteOn)}`,
    },
  );

  // Marked even when the deletion was cancelled while the email went out:
  // the daily run then tells the sender it was cancelled.
  await database.query(
    `
      UPDATE scheduled_envelope_deletions
      SET sender_notified_at = $1, delete_after = GREATEST(delete_after, $2)
      WHERE envelope_id = $3 AND requested_at = $4
    `,
    [now, deleteOn, target.envelopeId, target.requestedAt],
  );
}

/** Tells a sender who was told about a deletion that it was cancelled. */
async function sendCancellationNotice(
  target: NoticeTarget & { cancelledAt: number; cancelledByEmail: string },
  now: number,
  database: DbExecutor,
  emailService: EmailService,
): Promise<void> {
  const link = envelopeLink(target.envelopeId);

  await emailService.send(
    {
      subject: `"${target.title}" will not be deleted`,
      template: "deletion_notice",
      textBody: [
        greeting(target),
        "",
        `An administrator of your organization (${target.cancelledByEmail}) has cancelled the deletion of "${target.title}". It stays as it is.`,
        ...(link ? ["", link] : []),
      ].join("\n"),
      to: target.ownerEmail,
    },
    {
      idempotencyKey: `deletion-cancelled/${target.envelopeId}/${String(target.cancelledAt)}`,
    },
  );

  await database.query(
    `
      UPDATE scheduled_envelope_deletions
      SET cancel_notified_at = $1
      WHERE envelope_id = $2 AND cancelled_at = $3
    `,
    [now, target.envelopeId, target.cancelledAt],
  );
}

/**
 * Schedules a completed, declined or voided envelope, the administrator's
 * own or another member's, to be deleted once the waiting period is over,
 * and emails its sender a link to download it.
 */
export async function scheduleEnvelopeDeletion(
  envelopeId: string,
  {
    actor,
    ipAddress = null,
    reason,
    userAgent = null,
  }: EnvelopeDeletionRequest,
  {
    database = getDb(),
    emailService,
    now = currentTime(),
  }: {
    database?: DbPool;
    emailService?: EmailService;
    now?: number;
  } = {},
): Promise<ScheduledEnvelopeDeletion> {
  const deleteAfter = now + ENVELOPE_DELETION_WAIT_DAYS * DAY_IN_SECONDS;
  const scheduled = await withTransaction(async (tx) => {
    const { envelope, owner } = await lockFinishedEnvelope(
      tx,
      envelopeId,
      actor.userId,
    );
    const deletionReason = parseReason(reason, envelope.part11);
    const senderIsActor = envelope.ownerUserId === actor.userId;
    // A cancelled request is replaced; one still standing is not.
    const inserted = await tx.query(
      `
        INSERT INTO scheduled_envelope_deletions (
          envelope_id, requested_by_user_id, requested_by_email,
          requested_at, delete_after, reason, sender_notified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (envelope_id) DO UPDATE SET
          requested_by_user_id = EXCLUDED.requested_by_user_id,
          requested_by_email = EXCLUDED.requested_by_email,
          requested_at = EXCLUDED.requested_at,
          delete_after = EXCLUDED.delete_after,
          reason = EXCLUDED.reason,
          sender_notified_at = EXCLUDED.sender_notified_at,
          cancelled_at = NULL,
          cancelled_by_user_id = NULL,
          cancelled_by_email = NULL,
          cancel_notified_at = NULL,
          last_attempt_at = NULL
        WHERE scheduled_envelope_deletions.cancelled_at IS NOT NULL
      `,
      [
        envelope.id,
        actor.userId,
        actor.email,
        now,
        deleteAfter,
        deletionReason,
        // Nobody to tell when the sender asked themselves.
        senderIsActor ? now : null,
      ],
    );

    if (inserted.rowCount !== 1) {
      throw new EnvelopeMutationError(
        "This envelope is already scheduled to be deleted.",
        409,
      );
    }

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "envelope_deletion_scheduled",
        ipAddress,
        metadata: {
          deleteAfter,
          envelopeId: envelope.id,
          ownerEmail: owner?.email ?? null,
          ownerUserId: envelope.ownerUserId,
          part11: envelope.part11,
          reason: deletionReason,
          status: envelope.status,
          title: envelope.title,
        },
        targetUserId: envelope.ownerUserId,
        userAgent,
      },
      tx,
    );

    return {
      notice:
        !senderIsActor && owner
          ? {
              deleteAfter,
              envelopeId: envelope.id,
              ownerEmail: owner.email,
              ownerName: owner.name,
              requestedAt: now,
              requestedByEmail: actor.email,
              title: envelope.title,
            }
          : null,
      reason: deletionReason,
    };
  }, database);

  // The schedule stands whatever happens to the email. Until it goes out,
  // nothing is deleted, and the daily run tries again.
  if (scheduled.notice) {
    try {
      await sendDeletionNotice(
        scheduled.notice,
        now,
        database,
        emailService ?? createEmailService(),
      );
    } catch (error) {
      console.error(
        `Telling the sender about the deletion of envelope ${envelopeId} failed:`,
        error,
      );
    }
  }

  return {
    deleteAfter,
    reason: scheduled.reason,
    requestedAt: now,
    requestedByEmail: actor.email,
  };
}

/**
 * Cancels a scheduled deletion. Any administrator may, whoever asked for
 * it. A sender who was told it would go is told it will not.
 */
export async function cancelEnvelopeDeletion(
  envelopeId: string,
  {
    actor,
    ipAddress = null,
    userAgent = null,
  }: Omit<EnvelopeDeletionRequest, "reason">,
  {
    database = getDb(),
    emailService,
    now = currentTime(),
  }: {
    database?: DbPool;
    emailService?: EmailService;
    now?: number;
  } = {},
): Promise<{ envelopeId: string }> {
  const cancelled = await withTransaction(async (tx) => {
    const { envelope, owner } = await lockFinishedEnvelope(
      tx,
      envelopeId,
      actor.userId,
    );
    // Kept, marked cancelled, until the sender has been told: a notice
    // that was going out at this moment still gets its answer.
    const schedule = await queryOne<ScheduleRow>(
      tx,
      `
        UPDATE scheduled_envelope_deletions
        SET cancelled_at = $2, cancelled_by_user_id = $3, cancelled_by_email = $4
        WHERE envelope_id = $1 AND cancelled_at IS NULL
        RETURNING ${SCHEDULE_COLUMNS}
      `,
      [envelope.id, now, actor.userId, actor.email],
    );

    if (!schedule) {
      throw new EnvelopeMutationError(
        "This envelope is not scheduled to be deleted.",
        409,
      );
    }

    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.userId,
        event: "envelope_deletion_cancelled",
        ipAddress,
        metadata: {
          deleteAfter: schedule.deleteAfter,
          envelopeId: envelope.id,
          ownerEmail: owner?.email ?? null,
          ownerUserId: envelope.ownerUserId,
          requestedByEmail: schedule.requestedByEmail,
          title: envelope.title,
        },
        targetUserId: envelope.ownerUserId,
        userAgent,
      },
      tx,
    );

    return {
      // Only a sender who was told, and is someone else.
      notify:
        owner &&
        envelope.ownerUserId !== actor.userId &&
        envelope.ownerUserId !== schedule.requestedByUserId &&
        schedule.senderNotifiedAt !== null
          ? {
              cancelledAt: now,
              cancelledByEmail: actor.email,
              envelopeId: envelope.id,
              ownerEmail: owner.email,
              ownerName: owner.name,
              requestedAt: schedule.requestedAt,
              title: envelope.title,
            }
          : null,
    };
  }, database);
  const { notify } = cancelled;

  // A failure here is tried again by the daily run. As there, the request
  // stays locked while the email goes out, so a deletion scheduled again
  // meanwhile waits and its own notice comes after.
  if (notify) {
    try {
      await withTransaction(async (tx) => {
        if (await lockOwedNotice(notify, tx)) {
          await sendCancellationNotice(
            notify,
            now,
            tx,
            emailService ?? createEmailService(),
          );
        }
      }, database);
    } catch (error) {
      console.error(
        `Telling the sender about the cancelled deletion of envelope ${envelopeId} failed:`,
        error,
      );
    }
  }

  return { envelopeId };
}

/**
 * Deletes one envelope whose scheduled deletion is due, with its files,
 * and records the deletion in the install's audit trail under the
 * administrator who asked for it. False when there was nothing due: it was
 * cancelled, its sender has not been told yet, or it is not due yet.
 */
export async function deleteScheduledEnvelope(
  envelopeId: string,
  {
    database = getDb(),
    now = currentTime(),
    storageService = createStorageService(),
  }: {
    database?: DbPool;
    now?: number;
    storageService?: StorageService;
  } = {},
): Promise<boolean> {
  const result = await withTransaction(async (tx) => {
    const { envelope, owner } = await lockFinishedEnvelope(
      tx,
      envelopeId,
      null,
    );
    // Cancelled, not told, or not due by the time it was locked: nothing
    // to do.
    const schedule = await queryOne<ScheduleRow>(
      tx,
      `
        SELECT ${SCHEDULE_COLUMNS}
        FROM scheduled_envelope_deletions
        WHERE envelope_id = $1
          AND cancelled_at IS NULL
          AND sender_notified_at IS NOT NULL
          AND delete_after <= $2
        FOR UPDATE
      `,
      [envelope.id, now],
    );

    if (!schedule) {
      return null;
    }

    await recordSystemAuditEvent(
      {
        actorEmail: schedule.requestedByEmail,
        actorUserId: schedule.requestedByUserId,
        event: "envelope_deleted",
        metadata: {
          envelopeId: envelope.id,
          evidenceSha256: envelope.evidenceSha256,
          finishedAt: envelope.finishedAt,
          ownerEmail: owner?.email ?? null,
          ownerUserId: envelope.ownerUserId,
          part11: envelope.part11,
          reason: schedule.reason,
          recipientEvidenceSha256: envelope.recipientEvidenceSha256,
          requestedAt: schedule.requestedAt,
          senderNotifiedAt: schedule.senderNotifiedAt,
          signedPdfSha256: envelope.signedPdfSha256,
          sourcePdfHash: envelope.sourcePdfHash,
          status: envelope.status,
          title: envelope.title,
        },
        targetUserId: envelope.ownerUserId,
      },
      tx,
    );

    // The row, the record of its deletion and the list of its files commit
    // together. The files cannot roll back with them, so they go only after
    // the commit; one that cannot be deleted then stays on the list, and
    // the daily cleanup tries it again.
    const storageKeys = await listEnvelopeStorageKeys(envelope.id, tx);

    await queueFileDeletions(envelope.id, storageKeys, now, tx);
    await tx.query(`DELETE FROM envelopes WHERE id = $1`, [envelope.id]);

    return storageKeys;
  }, database);

  if (!result) {
    return false;
  }

  for (const key of result) {
    await deletePendingFile(key, database, storageService);
  }

  return true;
}

export type ScheduledDeletionSummary = {
  deleted: number;
  failures: string[];
  noticeFailures: string[];
  noticesSent: number;
};

type PendingNoticeRow = ScheduleRow & {
  envelopeId: string;
  ownerEmail: string;
  ownerName: string | null;
  title: string;
};

/** How long a cancelled request is kept for a notice still going out. */
const CANCELLED_KEPT_SECONDS = DAY_IN_SECONDS;
/** After this, a cancellation notice that keeps failing is given up. */
const CANCELLED_GIVE_UP_SECONDS = 30 * DAY_IN_SECONDS;

/**
 * Locks the request for a notice the row was read as owing, if it is still
 * owed as things are now: a request rescheduled or cancelled since the list
 * was read is owed something else, or nothing. The lock is held while the
 * email goes out, so a reschedule or cancellation waits for it and its own
 * email comes after.
 */
async function lockOwedNotice(
  row: Pick<PendingNoticeRow, "cancelledAt" | "envelopeId" | "requestedAt">,
  tx: DbExecutor,
): Promise<boolean> {
  const result =
    row.cancelledAt === null
      ? await tx.query(
          `
            SELECT 1
            FROM scheduled_envelope_deletions
            WHERE envelope_id = $1
              AND requested_at = $2
              AND cancelled_at IS NULL
              AND sender_notified_at IS NULL
            FOR UPDATE
          `,
          [row.envelopeId, row.requestedAt],
        )
      : await tx.query(
          `
            SELECT 1
            FROM scheduled_envelope_deletions
            WHERE envelope_id = $1
              AND cancelled_at = $2
              AND cancel_notified_at IS NULL
            FOR UPDATE
          `,
          [row.envelopeId, row.cancelledAt],
        );

  return result.rowCount === 1;
}

/**
 * The daily part: emails any sender still owed a notice of a deletion or of
 * its cancellation, clears cancelled requests nobody is owed anything for,
 * then deletes the envelopes whose wait is over.
 */
export async function runScheduledEnvelopeDeletions({
  database = getDb(),
  emailService,
  now = currentTime(),
  storageService = createStorageService(),
}: {
  database?: DbPool;
  emailService?: EmailService;
  now?: number;
  storageService?: StorageService;
} = {}): Promise<ScheduledDeletionSummary> {
  const summary: ScheduledDeletionSummary = {
    deleted: 0,
    failures: [],
    noticeFailures: [],
    noticesSent: 0,
  };
  // Owed a notice: a standing request the sender has not been told of, or
  // a cancelled one they were told of and not yet told was cancelled
  // (unless they asked or cancelled it themselves).
  const owed = await queryMany<PendingNoticeRow>(
    database,
    `
      SELECT
        s.envelope_id AS "envelopeId",
        ${SCHEDULE_COLUMNS},
        e.title,
        u.email AS "ownerEmail",
        u.name AS "ownerName"
      FROM scheduled_envelope_deletions s
      JOIN envelopes e ON e.id = s.envelope_id
      JOIN public."user" u ON u.id = e.user_id
      WHERE (s.cancelled_at IS NULL AND s.sender_notified_at IS NULL)
        OR (
          s.cancelled_at IS NOT NULL
          AND s.sender_notified_at IS NOT NULL
          AND s.cancel_notified_at IS NULL
          AND s.cancelled_at > $1
          AND e.user_id <> s.requested_by_user_id
          AND e.user_id <> s.cancelled_by_user_id
        )
      -- Never tried first, then the longest since the last try, so notices
      -- that keep failing cannot hold back the rest.
      ORDER BY s.last_attempt_at ASC NULLS FIRST, s.requested_at ASC
      LIMIT ${String(SCHEDULED_DELETIONS_PER_RUN)}
    `,
    [now - CANCELLED_GIVE_UP_SECONDS],
  );
  let service = emailService;

  for (const row of owed) {
    try {
      // Recorded first, and kept if the email fails, so a notice that
      // keeps failing goes behind the others next time.
      await database.query(
        `UPDATE scheduled_envelope_deletions SET last_attempt_at = $2 WHERE envelope_id = $1`,
        [row.envelopeId, now],
      );

      const emailService = (service ??= createEmailService());
      const notified = await withTransaction(async (tx) => {
        if (!(await lockOwedNotice(row, tx))) {
          return false;
        }

        if (row.cancelledAt === null) {
          await sendDeletionNotice(row, now, tx, emailService);
        } else {
          await sendCancellationNotice(
            {
              ...row,
              cancelledAt: row.cancelledAt,
              cancelledByEmail: row.cancelledByEmail ?? "",
            },
            now,
            tx,
            emailService,
          );
        }

        return true;
      }, database);

      if (notified) {
        summary.noticesSent += 1;
      }
    } catch (error) {
      summary.noticeFailures.push(row.envelopeId);
      console.error(
        `Telling the sender about the deletion of envelope ${row.envelopeId} failed:`,
        error,
      );
    }
  }

  // Cancelled requests are kept a day, for a notice that was going out as
  // they were cancelled, then until any cancellation notice owed has gone.
  await database.query(
    `
      DELETE FROM scheduled_envelope_deletions s
      USING envelopes e
      WHERE e.id = s.envelope_id
        AND s.cancelled_at IS NOT NULL
        AND (
          s.cancelled_at <= $2
          OR (
            s.cancelled_at <= $1
            AND (
              s.sender_notified_at IS NULL
              OR s.cancel_notified_at IS NOT NULL
              OR e.user_id = s.requested_by_user_id
              OR e.user_id = s.cancelled_by_user_id
            )
          )
        )
    `,
    [now - CANCELLED_KEPT_SECONDS, now - CANCELLED_GIVE_UP_SECONDS],
  );

  const due = await queryMany<{ envelopeId: string }>(
    database,
    `
      SELECT envelope_id AS "envelopeId"
      FROM scheduled_envelope_deletions
      WHERE cancelled_at IS NULL
        AND sender_notified_at IS NOT NULL
        AND delete_after <= $1
      ORDER BY last_attempt_at ASC NULLS FIRST, delete_after ASC, envelope_id ASC
      LIMIT ${String(SCHEDULED_DELETIONS_PER_RUN)}
    `,
    [now],
  );

  for (const { envelopeId } of due) {
    try {
      // Recorded before trying, so a deletion that keeps failing goes
      // behind the others next time.
      await database.query(
        `UPDATE scheduled_envelope_deletions SET last_attempt_at = $2 WHERE envelope_id = $1`,
        [envelopeId, now],
      );

      if (
        await deleteScheduledEnvelope(envelopeId, {
          database,
          now,
          storageService,
        })
      ) {
        summary.deleted += 1;

        // A file that could not be deleted stays queued for the next
        // cleanup, and this run is reported as failed for it, as the
        // retention sweep does.
        const filesLeft = await queryOne(
          database,
          `SELECT 1 FROM pending_file_deletions WHERE envelope_id = $1 LIMIT 1`,
          [envelopeId],
        );

        if (filesLeft) {
          summary.failures.push(envelopeId);
        }
      }
    } catch (error) {
      summary.failures.push(envelopeId);
      console.error(
        `The scheduled deletion of envelope ${envelopeId} failed:`,
        error,
      );
    }
  }

  return summary;
}
