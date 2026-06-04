import { NextResponse } from "next/server";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { generateApiKeyWithMachine } from "@/shared/utils/apiKey";
import { getPrisma, hasPrismaDatabaseUrl } from "@/lib/prisma";
import { v4 as uuidv4 } from "uuid";

export const dynamic = "force-dynamic";

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

// GET /api/keys - List API keys from PostgreSQL/Supabase only
export async function GET() {
  try {
    const rows = await getPostgresPrisma().apiKey.findMany({ orderBy: { createdAt: "asc" } });
    return NextResponse.json({ keys: rows.map(rowToKey) });
  } catch (error) {
    console.log("Error fetching keys from PostgreSQL:", error);
    return NextResponse.json({ error: "Failed to fetch keys from PostgreSQL" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key in PostgreSQL/Supabase only
export async function POST(request) {
  try {
    const body = await request.json();
    const { name } = body;
    const emailInput = body.userEmail ?? body.owner;

    if (!name?.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const userEmail = typeof emailInput === "string" ? emailInput.trim().toLowerCase() : "";
    if (!userEmail) {
      return NextResponse.json({ error: "User email is required" }, { status: 400 });
    }
    if (!EMAIL_PATTERN.test(userEmail)) {
      return NextResponse.json({ error: "User must be a valid email" }, { status: 400 });
    }

    const prisma = getPostgresPrisma();
    const user = await prisma.ownerUser.findUnique({ where: { email: userEmail } });
    if (!user) {
      return NextResponse.json({ error: "Create this user before assigning API keys" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const generated = generateApiKeyWithMachine(machineId);
    const apiKey = {
      id: uuidv4(),
      key: generated.key,
      name: name.trim(),
      owner: userEmail,
      machineId,
      isActive: true,
      createdAt: new Date().toISOString(),
    };

    await prisma.apiKey.create({
      data: {
        id: apiKey.id,
        key: apiKey.key,
        name: apiKey.name,
        owner: apiKey.owner,
        machineId: apiKey.machineId,
        isActive: 1,
        createdAt: apiKey.createdAt,
      },
    });

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      owner: apiKey.owner,
      userEmail: apiKey.owner,
      machineId: apiKey.machineId,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key in PostgreSQL:", error);
    return NextResponse.json({ error: "Failed to create key in PostgreSQL" }, { status: 500 });
  }
}
