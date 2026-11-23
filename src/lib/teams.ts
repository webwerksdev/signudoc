import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryMany,
  queryOne,
  withTransaction,
} from "./db/connection.ts";
import { emailSchema } from "./schemas/common.ts";
import { recordSystemAuditEvent } from "./services/system-audit.ts";

// Teams: people who can see each other's sent envelopes (what that lets
// them do is in envelope-access.ts). Only an administrator makes a team,
// renames it, deletes it, or changes who is on it, and every one of those
// changes is recorded in the install's audit trail in the same transaction.

export const MAX_TEAM_NAME_LENGTH = 80;

export type TeamMember = {
  email: string;
  id: string;
  name: string;
};

export type Team = {
  id: string;
  members: TeamMember[];
  name: string;
};

export type TeamActor = {
  email: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  userId: string;
};

export class TeamError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "TeamError";
    this.statusCode = statusCode;
  }
}

const teamNameSchema = z
  .string()
  .trim()
  .min(1, "Give the team a name.")
  .max(MAX_TEAM_NAME_LENGTH, "Keep the team's name to 80 characters.");

export const createTeamSchema = z.object({
  name: teamNameSchema,
});

export const updateTeamSchema = z.object({
  name: teamNameSchema,
});

export const addTeamMemberSchema = z.object({
  email: emailSchema,
});

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);

  if (!parsed.success) {
    throw new TeamError(
      parsed.error.issues[0]?.message ?? "Check what you entered.",
      400,
    );
  }

  return parsed.data;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

/**
 * Refuses anyone but an administrator, read with a share of their account
 * row so a change of role waits for this transaction, or this one for it.
 */
async function assertAdministrator(actor: TeamActor, tx: DbExecutor) {
  const account = await queryOne<{ role: string }>(
    tx,
    `SELECT role FROM public."user" WHERE id = $1 FOR SHARE`,
    [actor.userId],
  );

  if (account?.role !== "admin") {
    throw new TeamError("Only an administrator can change teams.", 403);
  }
}

/** The team, held until the transaction ends. */
async function lockTeam(teamId: string, tx: DbExecutor) {
  const team = await queryOne<{ id: string; name: string }>(
    tx,
    `SELECT id, name FROM teams WHERE id = $1 FOR UPDATE`,
    [teamId],
  );

  if (!team) {
    throw new TeamError("That team no longer exists.", 404);
  }

  return team;
}

function auditContext(actor: TeamActor) {
  return {
    actorEmail: actor.email,
    actorUserId: actor.userId,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  };
}

/** Every team and who is on it, by name. */
export async function listTeams(
  database: DbExecutor = getDb(),
): Promise<Team[]> {
  const teams = await queryMany<{ id: string; name: string }>(
    database,
    `SELECT id, name FROM teams ORDER BY lower(name), id`,
  );
  const members = await queryMany<TeamMember & { teamId: string }>(
    database,
    `
      SELECT m.team_id AS "teamId", u.id, u.name, u.email
      FROM team_members m
      JOIN public."user" u ON u.id = m.user_id
      ORDER BY lower(u.name), lower(u.email), u.id
    `,
  );

  return teams.map((team) => ({
    ...team,
    members: members
      .filter((member) => member.teamId === team.id)
      .map(({ email, id, name }) => ({ email, id, name })),
  }));
}

/** The teams one person is on, by name. */
export async function listTeamsForUser(
  userId: string,
  database: DbExecutor = getDb(),
): Promise<{ id: string; name: string }[]> {
  return queryMany<{ id: string; name: string }>(
    database,
    `
      SELECT t.id, t.name
      FROM team_members m
      JOIN teams t ON t.id = m.team_id
      WHERE m.user_id = $1
      ORDER BY lower(t.name), t.id
    `,
    [userId],
  );
}

export async function createTeam(
  actor: TeamActor,
  input: unknown,
  database: DbPool = getDb(),
): Promise<{ id: string }> {
  const parsed = parseInput(createTeamSchema, input);
  const now = Math.floor(Date.now() / 1000);
  const id = randomUUID();

  try {
    await withTransaction(async (tx) => {
      await assertAdministrator(actor, tx);
      await tx.query(
        `
          INSERT INTO teams (id, name, created_at, updated_at)
          VALUES ($1, $2, $3, $3)
        `,
        [id, parsed.name, now],
      );
      await recordSystemAuditEvent(
        {
          ...auditContext(actor),
          createdAt: now,
          event: "team_created",
          metadata: { teamId: id, teamName: parsed.name },
        },
        tx,
      );
    }, database);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TeamError("There is already a team with that name.", 409);
    }

    throw error;
  }

  return { id };
}

/** Renames a team. */
export async function updateTeam(
  actor: TeamActor,
  teamId: string,
  input: unknown,
  database: DbPool = getDb(),
): Promise<void> {
  const parsed = parseInput(updateTeamSchema, input);
  const now = Math.floor(Date.now() / 1000);

  try {
    await withTransaction(async (tx) => {
      await assertAdministrator(actor, tx);

      const team = await lockTeam(teamId, tx);

      if (parsed.name === team.name) {
        return;
      }

      await tx.query(
        `UPDATE teams SET name = $1, updated_at = $2 WHERE id = $3`,
        [parsed.name, now, teamId],
      );
      await recordSystemAuditEvent(
        {
          ...auditContext(actor),
          createdAt: now,
          event: "team_updated",
          metadata: {
            from: { teamName: team.name },
            teamId,
            teamName: parsed.name,
          },
        },
        tx,
      );
    }, database);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new TeamError("There is already a team with that name.", 409);
    }

    throw error;
  }
}

/**
 * Deletes a team. Its members keep their envelopes; they just stop seeing
 * each other's through it.
 */
export async function deleteTeam(
  actor: TeamActor,
  teamId: string,
  database: DbPool = getDb(),
): Promise<void> {
  await withTransaction(async (tx) => {
    await assertAdministrator(actor, tx);

    const team = await lockTeam(teamId, tx);
    const members = await queryMany<{ id: string }>(
      tx,
      `SELECT user_id AS id FROM team_members WHERE team_id = $1`,
      [teamId],
    );

    await tx.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
    await recordSystemAuditEvent(
      {
        ...auditContext(actor),
        event: "team_deleted",
        metadata: {
          memberCount: members.length,
          memberIds: members.map((member) => member.id),
          teamId,
          teamName: team.name,
        },
      },
      tx,
    );
  }, database);
}

/** Puts the account with this email address on the team. */
export async function addTeamMember(
  actor: TeamActor,
  teamId: string,
  input: unknown,
  database: DbPool = getDb(),
): Promise<TeamMember> {
  const parsed = parseInput(addTeamMemberSchema, input);
  const now = Math.floor(Date.now() / 1000);

  return withTransaction(async (tx) => {
    await assertAdministrator(actor, tx);

    const team = await lockTeam(teamId, tx);
    const member = await queryOne<TeamMember>(
      tx,
      `
        SELECT id, name, email
        FROM public."user"
        WHERE lower(email) = lower($1)
      `,
      [parsed.email],
    );

    if (!member) {
      throw new TeamError(
        "Nobody has an account with that email address. They need one before they can join a team.",
        404,
      );
    }

    const added = await tx.query(
      `
        INSERT INTO team_members (team_id, user_id, added_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (team_id, user_id) DO NOTHING
      `,
      [teamId, member.id, now],
    );

    if (added.rowCount === 1) {
      await recordSystemAuditEvent(
        {
          ...auditContext(actor),
          createdAt: now,
          event: "team_member_added",
          metadata: {
            targetEmail: member.email,
            targetName: member.name,
            teamId,
            teamName: team.name,
          },
          targetUserId: member.id,
        },
        tx,
      );
    }

    return member;
  }, database);
}

export async function removeTeamMember(
  actor: TeamActor,
  teamId: string,
  userId: string,
  database: DbPool = getDb(),
): Promise<void> {
  await withTransaction(async (tx) => {
    await assertAdministrator(actor, tx);

    const team = await lockTeam(teamId, tx);
    const removed = await queryOne<{ email: string; name: string }>(
      tx,
      `
        WITH removed AS (
          DELETE FROM team_members
          WHERE team_id = $1 AND user_id = $2
          RETURNING user_id
        )
        SELECT u.name, u.email
        FROM removed
        JOIN public."user" u ON u.id = removed.user_id
      `,
      [teamId, userId],
    );

    if (!removed) {
      throw new TeamError("That person is not on this team.", 404);
    }

    await recordSystemAuditEvent(
      {
        ...auditContext(actor),
        event: "team_member_removed",
        metadata: {
          targetEmail: removed.email,
          targetName: removed.name,
          teamId,
          teamName: team.name,
        },
        targetUserId: userId,
      },
      tx,
    );
  }, database);
}
