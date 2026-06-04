import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { buildModelManagementCatalog, buildModelsList } from "@/app/api/v1/models/route.js";

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return adminOptionsResponse();
}

export async function GET(request) {
  return withAdminApiKey(request, async () => {
    try {
      const { searchParams } = new URL(request.url);
      const view = searchParams.get("view") || "management";

      if (view === "public") {
        const data = await buildModelsList(["llm"]);
        return adminJson({ object: "list", data });
      }

      if (view !== "management") {
        return adminJson({ error: "Invalid view. Use management or public." }, { status: 400 });
      }

      const catalog = await buildModelManagementCatalog();
      return adminJson(catalog);
    } catch (error) {
      console.error("[Admin API] Failed to fetch models:", error);
      return adminJson({ error: "Failed to fetch models" }, { status: 500 });
    }
  });
}
