import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { addOwnerBudget, deleteOwnerUser, getOwnerBudgetState, upsertOwnerUser } from "@/lib/localDb";
import { resetUsageForOwner } from "@/lib/usageDb";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function OPTIONS() {
  return adminOptionsResponse();
}

function normalizeEmail(email) {
  return typeof email === "string" ? decodeURIComponent(email).trim().toLowerCase() : "";
}

function parseBudget(value) {
  const budgetUsd = Number(value);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return null;
  return budgetUsd;
}

function parseBudgetIncrement(value) {
  const amountUsd = Number(value);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return null;
  return amountUsd;
}

async function getEmail(params) {
  const { email: encodedEmail } = await params;
  const email = normalizeEmail(encodedEmail);
  if (!EMAIL_PATTERN.test(email)) return null;
  return email;
}

export async function GET(request, { params }) {
  return withAdminApiKey(request, async () => {
    const email = await getEmail(params);
    if (!email) return adminJson({ error: "Valid email is required" }, { status: 400 });

    const user = await getOwnerBudgetState(email);
    if (!user.configured) return adminJson({ error: "User budget not found" }, { status: 404 });
    return adminJson({ user });
  });
}

export async function PATCH(request, { params }) {
  return withAdminApiKey(request, async () => {
    try {
      const email = await getEmail(params);
      if (!email) return adminJson({ error: "Valid email is required" }, { status: 400 });

      const body = await request.json();
      const budgetUsd = parseBudget(body.budgetUsd);
      if (budgetUsd === null) {
        return adminJson({ error: "Budget must be a non-negative number" }, { status: 400 });
      }

      const user = await upsertOwnerUser({
        email,
        budgetUsd,
        isActive: body.isActive !== false,
      });
      return adminJson({ user });
    } catch (error) {
      console.error("[Admin API] Failed to update user:", error);
      return adminJson({ error: error.message || "Failed to update user" }, { status: 500 });
    }
  });
}

export async function POST(request, { params }) {
  return withAdminApiKey(request, async () => {
    try {
      const email = await getEmail(params);
      if (!email) return adminJson({ error: "Valid email is required" }, { status: 400 });

      const body = await request.json().catch(() => ({}));
      if (body.action === "add-budget") {
        const amountUsd = parseBudgetIncrement(body.amountUsd);
        if (amountUsd === null) {
          return adminJson({ error: "Amount must be greater than zero" }, { status: 400 });
        }
        const user = await addOwnerBudget(email, amountUsd);
        return adminJson({ user });
      }

      if (body.action === "reset-usage") {
        const reset = await resetUsageForOwner(email);
        const user = await getOwnerBudgetState(email);
        return adminJson({ user, reset });
      }

      return adminJson({ error: "Unsupported user action" }, { status: 400 });
    } catch (error) {
      console.error("[Admin API] Failed to apply user action:", error);
      const status = error.message === "User budget not found" ? 404 : 500;
      return adminJson({ error: error.message || "Failed to update user" }, { status });
    }
  });
}

export async function DELETE(request, { params }) {
  return withAdminApiKey(request, async () => {
    try {
      const email = await getEmail(params);
      if (!email) return adminJson({ error: "Valid email is required" }, { status: 400 });

      const deleted = await deleteOwnerUser(email);
      if (!deleted) return adminJson({ error: "User budget not found" }, { status: 404 });
      return adminJson({ message: "User budget removed" });
    } catch (error) {
      console.error("[Admin API] Failed to delete user:", error);
      return adminJson({ error: "Failed to delete user" }, { status: 500 });
    }
  });
}
