import { apiJson } from "@/lib/api/http";
import { handleApi } from "@/lib/api/route";
import { listTemplatesForUser } from "@/lib/templates";

// The key's saved templates, with their roles in signing order.
export async function GET(request: Request) {
  return handleApi(
    request,
    "read",
    "api_template_list_failure",
    async ({ actor }) => {
      const templates = await listTemplatesForUser(actor.userId);

      return apiJson({
        data: templates.map((template) => ({
          id: template.id,
          name: template.name,
          object: "template",
          roles: template.roleNames,
        })),
        object: "list",
      });
    },
  );
}
