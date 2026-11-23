import { handleTeamChange } from "@/lib/team-routes";
import { deleteTeam, updateTeam } from "@/lib/teams";

type TeamRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// Renames a team: { name }. Administrators only.
export async function PATCH(request: Request, context: TeamRouteContext) {
  const { id } = await context.params;

  return handleTeamChange(request, "team_update_failure", async (actor, body) =>
    updateTeam(actor, id, await body()),
  );
}

// Deletes a team. Its members keep their envelopes. Administrators only.
export async function DELETE(request: Request, context: TeamRouteContext) {
  const { id } = await context.params;

  return handleTeamChange(request, "team_delete_failure", (actor) =>
    deleteTeam(actor, id),
  );
}
