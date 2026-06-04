import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { deleteApiKey, getApiKeyById, getOwnerUserByEmail, updateApiKey } from "@/lib/localDb";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function OPTIONS() {
  return adminOptionsResponse();
}

function normalizeOwner(owner) {
  return typeof owner === "string" ? owner.trim().toLowerCase() : "";
}

async function validateOwner(owner) {
  if (owner === null) return { owner: null };
  const normalized = normalizeOwner(owner);
  if (!normalized) return undefined;
  if (!EMAIL_PATTERN.test(normalized)) {
    return { error: "Owner must be a valid email", status: 400 };
  }
  const user = await getOwnerUserByEmail(normalized);
  if (!user) {
    return { error: "Create this user before assigning API keys", status: 400 };
  }
  return { owner: normalized };
}

export async function GET(request, { params }) {
  return withAdminApiKey(request, async () => {
    try {
      const { id } = await params;
      const key = await getApiKeyById(id);
      if (!key) return adminJson({ error: "Key not found" }, { status: 404 });
      return adminJson({ key });
    } catch (error) {
      console.error("[Admin API] Failed to fetch API key:", error);
      return adminJson({ error: "Failed to fetch API key" }, { status: 500 });
    }
  });
}

export async function PATCH(request, { params }) {
  return withAdminApiKey(request, async () => {
    try {
      const { id } = await params;
      const body = await request.json();
      const existing = await getApiKeyById(id);
      if (!existing) return adminJson({ error: "Key not found" }, { status: 404 });

      const updateData = {};
      if (body.name !== undefined) {
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) return adminJson({ error: "Name must be a non-empty string" }, { status: 400 });
        updateData.name = name;
      }
      if (body.isActive !== undefined) updateData.isActive = body.isActive !== false;

      if (body.userEmail !== undefined || body.owner !== undefined) {
        const ownerValidation = await validateOwner(body.userEmail ?? body.owner);
        if (ownerValidation?.error) {
          return adminJson({ error: ownerValidation.error }, { status: ownerValidation.status });
        }
        updateData.owner = ownerValidation?.owner || null;
      }

      const key = await updateApiKey(id, updateData);
      return adminJson({ key });
    } catch (error) {
      console.error("[Admin API] Failed to update API key:", error);
      return adminJson({ error: "Failed to update API key" }, { status: 500 });
    }
  });
}

export async function DELETE(request, { params }) {
  return withAdminApiKey(request, async () => {
    try {
      const { id } = await params;
      const deleted = await deleteApiKey(id);
      if (!deleted) return adminJson({ error: "Key not found" }, { status: 404 });
      return adminJson({ message: "Key deleted successfully" });
    } catch (error) {
      console.error("[Admin API] Failed to delete API key:", error);
      return adminJson({ error: "Failed to delete API key" }, { status: 500 });
    }
  });
}
