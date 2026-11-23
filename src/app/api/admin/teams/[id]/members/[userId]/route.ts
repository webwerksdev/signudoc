import { handleTeamChange } from "@/lib/team-routes";
import { removeTeamMember } from "@/lib/teams";

type TeamMemberRouteContext = {
  params: Promise<{
    id: string;
    userId: string;
  }>;
};

// Takes someone off the team. Administrators only.
export async function DELETE(
  request: Request,
  context: TeamMemberRouteContext,
) {
  const { id, userId } = await context.params;

  return handleTeamChange(request, "team_member_remove_failure", (actor) =>
    removeTeamMember(actor, id, userId),
  );
}
