import { NextResponse } from "next/server";
import { getPrisma, hasPrismaDatabaseUrl } from "@/lib/prisma";
import { validateKeyAccessInput } from "@/shared/utils/keyAccess.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    owner: row.owner || null,
    userEmail: row.owner || null,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
  };
}

function getPostgresPrisma() {
  if (!hasPrismaDatabaseUrl()) {
    throw new Error("DATABASE_URL is required for dashboard API keys");
  }
  return getPrisma();
}

// GET /api/keys/[id] - Get single key from PostgreSQL/Supabase only
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = rowToKey(await getPostgresPrisma().apiKey.findUnique({ where: { id } }));
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key from PostgreSQL:", error);
    return NextResponse.json({ error: "Failed to fetch key from PostgreSQL" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key in PostgreSQL/Supabase only
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive, access } = body;
    const emailInput = body.userEmail ?? body.owner;

    const prisma = getPostgresPrisma();
    const existing = await prisma.apiKey.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive ? 1 : 0;
    if (emailInput !== undefined) {
      const userEmail = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
      if (!userEmail) {
        return NextResponse.json({ error: "User email is required" }, { status: 400 });
      }
      if (!EMAIL_PATTERN.test(userEmail)) {
        return NextResponse.json({ error: "User must be a valid email" }, { status: 400 });
      }
      const user = await prisma.ownerUser.findUnique({ where: { email: userEmail } });
      if (!user) {
        return NextResponse.json({ error: "Create this user before assigning API keys" }, { status: 400 });
      }
      updateData.owner = userEmail;
    }
    if (access !== undefined) {
      const checked = validateKeyAccessInput(access);
      if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
      // Per-key access control persists in the SQLite apiKeys
      // accessRestricted/accessAllow columns. Dashboard keys live in Postgres
      // here and the Prisma ApiKey model has no such fields, so a restriction
      // cannot be stored — refuse it loudly rather than dropping it silently,
      // which would leave the key fully open while the UI showed it locked.
      if (checked.value.restricted) {
        return NextResponse.json({ error: "Per-key access restrictions are not supported by the Postgres key store" }, { status: 501 });
      }
    }

    const updated = await prisma.apiKey.update({ where: { id }, data: updateData });

    return NextResponse.json({ key: rowToKey(updated) });
  } catch (error) {
    console.log("Error updating key in PostgreSQL:", error);
    return NextResponse.json({ error: "Failed to update key in PostgreSQL" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key from PostgreSQL/Supabase only
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const res = await getPostgresPrisma().apiKey.deleteMany({ where: { id } });
    if (res.count === 0) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key from PostgreSQL:", error);
    return NextResponse.json({ error: "Failed to delete key from PostgreSQL" }, { status: 500 });
  }
}
