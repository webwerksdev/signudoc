import { type DbExecutor, getDb, queryOne } from "./db/connection.ts";

// Whose envelope a signed-in account is looking at. Its sender sees it, as
// before. Someone on a team with the sender sees it once it has been sent,
// to read and download. An administrator sees every envelope in the
// install that has been sent, to read, download and, once it is finished,
// delete. A draft stays its sender's own until it is sent. Everything else
// that changes an envelope (sending, voiding, reminders, editing) stays
// with its sender.

export type EnvelopeViewerAccess = {
  ownerEmail: string;
  ownerName: string | null;
  ownerUserId: string;
  /** Whether the viewer is an administrator of the install. */
  viewerIsAdmin: boolean;
  /**
   * False when an administrator, or someone on a team with the sender, is
   * looking at someone else's envelope.
   */
  viewerIsOwner: boolean;
};

type AccessRow = {
  ownerEmail: string;
  ownerName: string | null;
  ownerUserId: string;
  sharesTeam: boolean;
  status: string;
  viewerRole: string | null;
};

/**
 * SQL that is true when the account whose id is the parameter `viewer`
 * (for example "$1") is on a team with the sender of the envelope row
 * named by `alias`.
 */
export function sharesTeamCondition(
  viewer: string,
  alias = "envelopes",
): string {
  return `EXISTS (
    SELECT 1
    FROM team_members viewer_membership
    JOIN team_members owner_membership
      ON owner_membership.team_id = viewer_membership.team_id
    WHERE viewer_membership.user_id = ${viewer}
      AND owner_membership.user_id = ${alias}.user_id
  )`;
}

/**
 * The envelope's sender, when `viewerUserId` may see it: as its sender, as
 * someone on a team with them, or as an administrator. Null when the
 * envelope does not exist or is not theirs to see, which callers report as
 * "not found".
 */
export async function resolveEnvelopeViewerAccess(
  viewerUserId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<EnvelopeViewerAccess | null> {
  const row = await queryOne<AccessRow>(
    database,
    `
      SELECT
        e.user_id AS "ownerUserId",
        owner.email AS "ownerEmail",
        owner.name AS "ownerName",
        e.status,
        (SELECT role FROM public."user" WHERE id = $2) AS "viewerRole",
        ${sharesTeamCondition("$2", "e")} AS "sharesTeam"
      FROM envelopes e
      JOIN public."user" owner ON owner.id = e.user_id
      WHERE e.id = $1
    `,
    [envelopeId, viewerUserId],
  );

  if (!row) {
    return null;
  }

  const viewerIsOwner = row.ownerUserId === viewerUserId;

  // Someone else's envelope only for an administrator or a teammate, and
  // never their draft.
  if (
    !viewerIsOwner &&
    ((row.viewerRole !== "admin" && !row.sharesTeam) || row.status === "draft")
  ) {
    return null;
  }

  return {
    ownerEmail: row.ownerEmail,
    ownerName: row.ownerName,
    ownerUserId: row.ownerUserId,
    viewerIsAdmin: row.viewerRole === "admin",
    viewerIsOwner,
  };
}

/** How someone other than the sender sees who sent an envelope. */
export function formatEnvelopeOwner(
  access: Pick<EnvelopeViewerAccess, "ownerEmail" | "ownerName">,
): string {
  const name = access.ownerName?.trim();

  return name ? `${name} (${access.ownerEmail})` : access.ownerEmail;
}
