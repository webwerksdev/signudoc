import { apiError, apiJson } from "@/lib/api/http";
import { requireApiKey, withRateLimitHeaders } from "@/lib/auth/api-key";
import { logRouteError } from "@/lib/security/logging";
import { getRequestPathname } from "@/lib/security/request";

// Which key this is and whom it acts as. The simplest way to check that a
// key works.
export async function GET(request: Request) {
  try {
    return await answer(request);
  } catch (error) {
    // Such as the database being out of reach: still the API's own error
    // shape, not Next.js's error page.
    logRouteError(error, {
      category: "api_me_failure",
      message: "Unexpected failure in an API request.",
      path: getRequestPathname(request),
    });

    return apiError(
      500,
      "internal_error",
      "Something went wrong on the install. Try again later.",
    );
  }
}

async function answer(request: Request) {
  const principal = await requireApiKey(request, "read");

  if (principal instanceof Response) {
    return principal;
  }

  return withRateLimitHeaders(
    apiJson({
      key: {
        id: principal.apiKey.id,
        name: principal.apiKey.name,
        scope: principal.apiKey.scope,
      },
      user: {
        email: principal.user.email,
        id: principal.user.id,
        name: principal.user.name,
      },
    }),
    principal.rateLimit,
  );
}
