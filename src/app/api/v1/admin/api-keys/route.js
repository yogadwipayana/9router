import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { createApiKey, getApiKeys, getOwnerUserByEmail } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return adminOptionsResponse();
}

function normalizeOwner(owner) {
  return typeof owner === "string" ? owner.trim().toLowerCase() : "";
}

async function validateOwner(owner) {
  const normalized = normalizeOwner(owner);
  if (!normalized) return null;
  if (!EMAIL_PATTERN.test(normalized)) {
    return { error: "Owner must be a valid email", status: 400 };
  }
  const user = await getOwnerUserByEmail(normalized);
  if (!user) {
    return { error: "Create this user before assigning API keys", status: 400 };
  }
  return { owner: normalized };
}

export async function GET(request) {
  return withAdminApiKey(request, async () => {
    try {
      const keys = await getApiKeys();
      return adminJson({ keys });
    } catch (error) {
      console.error("[Admin API] Failed to fetch API keys:", error);
      return adminJson({ error: "Failed to fetch API keys" }, { status: 500 });
    }
  });
}

export async function POST(request) {
  return withAdminApiKey(request, async () => {
    try {
      const body = await request.json();
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return adminJson({ error: "Name is required" }, { status: 400 });

      const ownerValidation = await validateOwner(body.userEmail ?? body.owner);
      if (ownerValidation?.error) {
        return adminJson({ error: ownerValidation.error }, { status: ownerValidation.status });
      }

      const machineId = await getConsistentMachineId();
      const apiKey = await createApiKey(name, machineId, ownerValidation?.owner || null);

      return adminJson({
        key: apiKey.key,
        name: apiKey.name,
        id: apiKey.id,
        owner: apiKey.owner,
        userEmail: apiKey.userEmail,
        machineId: apiKey.machineId,
      }, { status: 201 });
    } catch (error) {
      console.error("[Admin API] Failed to create API key:", error);
      return adminJson({ error: "Failed to create API key" }, { status: 500 });
    }
  });
}
