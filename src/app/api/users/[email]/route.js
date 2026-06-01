import { NextResponse } from "next/server";
import { addOwnerBudget, deleteOwnerUser, getOwnerBudgetState, upsertOwnerUser } from "@/lib/localDb";
import { resetUsageForOwner } from "@/lib/usageDb";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export async function PATCH(request, { params }) {
  try {
    const { email: encodedEmail } = await params;
    const email = normalizeEmail(encodedEmail);
    const body = await request.json();
    const budgetUsd = parseBudget(body.budgetUsd);

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }
    if (budgetUsd === null) {
      return NextResponse.json({ error: "Budget must be a non-negative number" }, { status: 400 });
    }

    const user = await upsertOwnerUser({
      email,
      budgetUsd,
      isActive: body.isActive !== false,
    });

    return NextResponse.json({ user });
  } catch (error) {
    console.error("Error updating user:", error);
    return NextResponse.json({ error: error.message || "Failed to update user" }, { status: 500 });
  }
}

export async function POST(request, { params }) {
  try {
    const { email: encodedEmail } = await params;
    const email = normalizeEmail(encodedEmail);
    const body = await request.json().catch(() => ({}));

    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    if (body.action === "add-budget") {
      const amountUsd = parseBudgetIncrement(body.amountUsd);
      if (amountUsd === null) {
        return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 });
      }
      const user = await addOwnerBudget(email, amountUsd);
      return NextResponse.json({ user });
    }

    if (body.action === "reset-usage") {
      const reset = await resetUsageForOwner(email);
      const user = await getOwnerBudgetState(email);
      return NextResponse.json({ user, reset });
    }

    return NextResponse.json({ error: "Unsupported user action" }, { status: 400 });
  } catch (error) {
    console.error("Error applying user action:", error);
    const status = error.message === "User budget not found" ? 404 : 500;
    return NextResponse.json({ error: error.message || "Failed to update user" }, { status });
  }
}

export async function DELETE(request, { params }) {
  try {
    const { email: encodedEmail } = await params;
    const email = normalizeEmail(encodedEmail);
    if (!EMAIL_PATTERN.test(email)) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    const deleted = await deleteOwnerUser(email);
    if (!deleted) {
      return NextResponse.json({ error: "User budget not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "User budget removed" });
  } catch (error) {
    console.error("Error deleting user:", error);
    return NextResponse.json({ error: "Failed to delete user" }, { status: 500 });
  }
}
