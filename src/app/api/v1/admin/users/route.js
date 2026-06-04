import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { getOwnerUsers, upsertOwnerUser } from "@/lib/localDb";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const dynamic = "force-dynamic";

export async function OPTIONS() {
  return adminOptionsResponse();
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function parseBudget(value) {
  const budgetUsd = Number(value);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return null;
  return budgetUsd;
}

export async function GET(request) {
  return withAdminApiKey(request, async () => {
    try {
      const users = await getOwnerUsers();
      return adminJson({ users });
    } catch (error) {
      console.error("[Admin API] Failed to fetch users:", error);
      return adminJson({ error: "Failed to fetch users" }, { status: 500 });
    }
  });
}

export async function POST(request) {
  return withAdminApiKey(request, async () => {
    try {
      const body = await request.json();
      const email = normalizeEmail(body.email);
      const budgetUsd = parseBudget(body.budgetUsd);

      if (!EMAIL_PATTERN.test(email)) {
        return adminJson({ error: "Valid email is required" }, { status: 400 });
      }
      if (budgetUsd === null) {
        return adminJson({ error: "Budget must be a non-negative number" }, { status: 400 });
      }

      const user = await upsertOwnerUser({
        email,
        budgetUsd,
        isActive: body.isActive !== false,
      });

      return adminJson({ user }, { status: 201 });
    } catch (error) {
      console.error("[Admin API] Failed to create user:", error);
      return adminJson({ error: error.message || "Failed to create user" }, { status: 500 });
    }
  });
}
