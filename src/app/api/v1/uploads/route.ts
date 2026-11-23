import { apiError, apiJson } from "@/lib/api/http";
import { applyAccountLimit, handleApi } from "@/lib/api/route";
import { issueApiUpload } from "@/lib/api/uploads";
import { supportsDirectUploads } from "@/lib/services/storage";

// A signed URL for uploading one large PDF straight to Vercel Blob, for
// files over the 4.5 MB a request to the app can carry.
export async function POST(request: Request) {
  return handleApi(request, "write", "api_upload_failure", async (context) => {
    if (!supportsDirectUploads()) {
      return apiError(
        404,
        "not_found",
        "This install keeps files on its own disk, so send the PDF in the create request instead.",
      );
    }

    const limited = await applyAccountLimit(context, {
      key: "api-upload",
      limit: 60,
      windowMs: 10 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }

    return apiJson(await issueApiUpload(context.actor.userId), { status: 201 });
  });
}
