import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { getModelAliases, setModelAlias } from "@/models";

export async function OPTIONS() {
  return adminOptionsResponse();
}

export async function PUT(request) {
  return withAdminApiKey(request, async () => {
    try {
      const body = await request.json();
      const model = typeof body.model === "string" ? body.model.trim() : "";
      const alias = typeof body.alias === "string" ? body.alias.trim() : "";

      if (!model || !alias) {
        return adminJson({ error: "Model and alias required" }, { status: 400 });
      }

      const modelAliases = await getModelAliases();
      const existingModel = Object.entries(modelAliases).find(
        ([key, value]) => value === alias && key !== model
      );

      if (existingModel) {
        return adminJson({ error: "Alias already in use" }, { status: 400 });
      }

      await setModelAlias(model, alias);
      return adminJson({ success: true, model, alias });
    } catch (error) {
      console.error("[Admin API] Failed to update model alias:", error);
      return adminJson({ error: "Failed to update model alias" }, { status: 500 });
    }
  });
}
