import { handleTeamChange } from "@/lib/team-routes";
import { addTeamMember } from "@/lib/teams";

type TeamMembersRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// Puts someone with an account on the team: { email }. Administrators only.
export async function POST(request: Request, context: TeamMembersRouteContext) {
  const { id } = await context.params;

  return handleTeamChange(
    request,
    "team_member_add_failure",
    async (actor, body) => addTeamMember(actor, id, await body()),
  );
}
