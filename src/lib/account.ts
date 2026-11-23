import {
  accountClosureConfirmationPhrase,
  accountClosureRequestSchema,
  senderProfileSchema,
  updateProfileSchema,
  type AccountClosureRequestInput,
  type SenderProfile,
  type UpdateProfileInput,
} from "./schemas/auth.ts";
import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { ROLE_CHANGE_LOCK_ID } from "./people.ts";
import {
  ACCOUNT_CLOSURE_EXPORT_WINDOW_DAYS,
  scheduleAccountClosure,
} from "./retention.ts";
import { resolvePublicSupportAddress } from "./public-contact.ts";
import type { RequestClient } from "./security/request.ts";
import { createEmailService } from "./services/email.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";
import { getBranding } from "./settings.ts";
import { isHostedMode, type EnvSource } from "./utils/env.ts";

type SenderAccountRow = {
  email: string;
  id: string;
  name: string;
};

type EnvelopeCountRow = {
  status: string;
  total: number;
};

type RequestAccountClosureOptions = {
  /** Where the request came from, for the audit trail. */
  client?: RequestClient;
  database?: DbExecutor;
  env?: EnvSource;
};

type AccountClosureRequestResult = {
  alreadyQueued: boolean;
  exportExpiresAt: number;
  purgeAfterAt: number;
  submittedAt: number;
};

export class AccountMutationError extends Error {
  readonly fieldErrors: Partial<Record<string, string>>;
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
    fieldErrors: Partial<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "AccountMutationError";
    this.fieldErrors = fieldErrors;
    this.statusCode = statusCode;
  }
}

const envelopeStatuses = [
  "draft",
  "sent",
  "completed",
  "declined",
  "voided",
] as const;

async function getSenderAccountRow(
  userId: string,
  database: DbExecutor,
): Promise<SenderAccountRow | null> {
  return queryOne<SenderAccountRow>(
    database,
    `
      SELECT
        id,
        email,
        name
      FROM "user"
      WHERE id = $1
    `,
    [userId],
  );
}

function mapSenderProfile(row: SenderAccountRow): SenderProfile {
  return senderProfileSchema.parse({
    email: row.email,
    fullName: row.name,
    id: row.id,
  });
}

function buildProfileValidationErrors(input: unknown) {
  const parsedInput = updateProfileSchema.safeParse(input);

  if (parsedInput.success) {
    return parsedInput.data;
  }

  const fieldErrors: Partial<Record<keyof UpdateProfileInput, string>> = {};

  for (const issue of parsedInput.error.issues) {
    const field = issue.path[0];

    if (field === "email") {
      fieldErrors.email = "Enter a valid email address";
    }

    if (field === "fullName") {
      fieldErrors.fullName = "Enter your full name";
    }
  }

  throw new AccountMutationError("Invalid profile input.", 400, fieldErrors);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function updateSenderProfile(
  userId: string,
  input: UpdateProfileInput,
  database: DbExecutor = getDb(),
): Promise<SenderProfile> {
  const normalizedInput = buildProfileValidationErrors(input);
  const account = await getSenderAccountRow(userId, database);

  if (!account) {
    throw new AccountMutationError("Account not found.", 404);
  }

  const normalizedEmail = normalizeEmail(normalizedInput.email);

  if (normalizeEmail(account.email) !== normalizedEmail) {
    throw new AccountMutationError(
      "Use the verified email change flow to update your sender email.",
      400,
      {
        email: "Use the secure email change flow.",
      },
    );
  }

  try {
    const result = await database.query(
      `
        UPDATE "user"
        SET
          name = $1,
          "updatedAt" = $2
        WHERE id = $3
      `,
      [normalizedInput.fullName.trim(), new Date().toISOString(), userId],
    );

    if (result.rowCount !== 1) {
      throw new Error("Profile update affected an unexpected number of rows.");
    }
  } catch {
    throw new AccountMutationError("Unable to update your profile.", 500);
  }

  return mapSenderProfile({
    email: account.email,
    id: userId,
    name: normalizedInput.fullName.trim(),
  });
}

function buildClosureValidationError(
  input: unknown,
): AccountClosureRequestInput {
  const parsedInput = accountClosureRequestSchema.safeParse(input);

  if (parsedInput.success) {
    return parsedInput.data;
  }

  throw new AccountMutationError(
    "Type the confirmation phrase to continue.",
    400,
    {
      confirmation: `Type "${accountClosureConfirmationPhrase}" to confirm.`,
    },
  );
}

export const LAST_ADMIN_CLOSURE_MESSAGE =
  "You are the only administrator. Make someone else an administrator first, then close your account.";

/**
 * Why this account may not be closed, or null when it may: the last
 * administrator would leave the install with nobody to run it.
 */
export async function accountClosureBlock(
  user: { id: string },
  database: DbExecutor = getDb(),
  env: EnvSource = process.env,
): Promise<string | null> {
  // The hosted service has no install to keep running.
  if (isHostedMode(env)) {
    return null;
  }

  const row = await queryOne<{ has_other_admin: boolean; role: string }>(
    database,
    `
      SELECT
        role,
        EXISTS (
          SELECT 1
          FROM "user" AS other
          WHERE other.role = 'admin'
            AND other.id <> $1
            AND NOT EXISTS (
              SELECT 1
              FROM account_closure_requests
              WHERE account_closure_requests.user_id = other.id
            )
        ) AS has_other_admin
      FROM "user"
      WHERE id = $1
    `,
    [user.id],
  );

  return row?.role === "admin" && !row.has_other_admin
    ? LAST_ADMIN_CLOSURE_MESSAGE
    : null;
}

function isPool(database: DbExecutor): database is DbPool {
  return "connect" in database && "totalCount" in database;
}

async function formatEnvelopeCounts(
  userId: string,
  database: DbExecutor,
): Promise<string[]> {
  const countRows = await queryMany<EnvelopeCountRow>(
    database,
    `
      SELECT
        status,
        COUNT(*) AS total
      FROM envelopes
      WHERE user_id = $1
      GROUP BY status
    `,
    [userId],
  );
  const totalsByStatus = new Map(
    countRows.map((row) => [row.status, row.total] as const),
  );

  return envelopeStatuses.map(
    (status) => `- ${status}: ${String(totalsByStatus.get(status) ?? 0)}`,
  );
}

function formatRetentionDeadline(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace(".000Z", " UTC");
}

export async function requestAccountClosure(
  userId: string,
  input: unknown,
  {
    client = {},
    database = getDb(),
    env = process.env,
  }: RequestAccountClosureOptions = {},
): Promise<AccountClosureRequestResult> {
  buildClosureValidationError(input);

  const account = await getSenderAccountRow(userId, database);

  if (!account) {
    throw new AccountMutationError("Account not found.", 404);
  }

  // Under the lock role changes take, so two administrators closing their
  // accounts at once cannot both count the other as the one who stays.
  const guardAndSchedule = async (tx: DbExecutor) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [ROLE_CHANGE_LOCK_ID]);

    const blocked = await accountClosureBlock(account, tx, env);

    if (blocked) {
      throw new AccountMutationError(blocked, 409);
    }

    return scheduleAccountClosure(userId, tx);
  };
  const closureSchedule = isPool(database)
    ? await withTransaction(guardAndSchedule, database)
    : await guardAndSchedule(database);

  if (!closureSchedule.alreadyQueued) {
    await recordSystemAuditEvent(
      {
        actorEmail: account.email,
        actorUserId: userId,
        event: "account_closure_requested",
        ipAddress: client.ipAddress ?? null,
        metadata: { purgeAfterAt: closureSchedule.purgeAfterAt },
        targetUserId: userId,
        userAgent: client.userAgent ?? null,
      },
      database,
    ).catch((error: unknown) => {
      console.error(
        `Failed to record the account closure request for user ${userId}:`,
        error,
      );
    });

    const submittedAt = formatRetentionDeadline(closureSchedule.requestedAt);
    const exportExpiresAt = formatRetentionDeadline(
      closureSchedule.exportExpiresAt,
    );
    const purgeAfterAt = formatRetentionDeadline(closureSchedule.purgeAfterAt);

    try {
      const emailService = createEmailService({ env });
      const supportAddress = await resolvePublicSupportAddress(env);
      const { productName } = await getBranding(env);

      await emailService.send({
        replyTo: account.email,
        subject: `Account closure request — ${account.name}`,
        template: "account_closure_request",
        textBody: [
          `A sender requested account closure from the ${productName} settings page.`,
          "",
          `Sender: ${account.name} <${account.email}>`,
          `User ID: ${userId}`,
          `Submitted at: ${submittedAt}`,
          `Export window: ${ACCOUNT_CLOSURE_EXPORT_WINDOW_DAYS} days`,
          `Export window ends: ${exportExpiresAt}`,
          `Automatic purge eligible at: ${purgeAfterAt}`,
          "",
          "Envelope counts:",
          ...(await formatEnvelopeCounts(userId, database)),
          "",
          "This request came through the guarded in-app danger-zone flow.",
        ].join("\n"),
        to: supportAddress,
      });
    } catch (error) {
      console.error(
        `Failed to send account closure email for user ${userId}:`,
        error,
      );
    }
  }

  return {
    alreadyQueued: closureSchedule.alreadyQueued,
    exportExpiresAt: closureSchedule.exportExpiresAt,
    purgeAfterAt: closureSchedule.purgeAfterAt,
    submittedAt: closureSchedule.requestedAt,
  };
}
