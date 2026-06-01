import { NextResponse } from "next/server";
import { getOwnerUsers, upsertOwnerUser } from "@/lib/localDb";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const dynamic = "force-dynamic";

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function parseBudget(value) {
  const budgetUsd = Number(value);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) return null;
  return budgetUsd;
}

export async function GET() {
  try {
    const users = await getOwnerUsers();
    return NextResponse.json({ users });
  } catch (error) {
    console.error("Error fetching users:", error);
    return NextResponse.json({ error: "Failed to fetch users" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const email = normalizeEmail(body.email);
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

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    console.error("Error saving user:", error);
    return NextResponse.json({ error: error.message || "Failed to save user" }, { status: 500 });
  }
}
