import { NextResponse } from "next/server";
import { getApiKeys, createApiKey, getOwnerUserByEmail } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";

export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/keys - List API keys
export async function GET() {
  try {
    const keys = await getApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.log("Error fetching keys:", error);
    return NextResponse.json({ error: "Failed to fetch keys" }, { status: 500 });
  }
}

// POST /api/keys - Create new API key
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

    const user = await getOwnerUserByEmail(userEmail);
    if (!user) {
      return NextResponse.json({ error: "Create this user before assigning API keys" }, { status: 400 });
    }

    // Always get machineId from server
    const machineId = await getConsistentMachineId();
    const apiKey = await createApiKey(name.trim(), machineId, userEmail);

    return NextResponse.json({
      key: apiKey.key,
      name: apiKey.name,
      id: apiKey.id,
      owner: apiKey.owner,
      userEmail: apiKey.userEmail,
      machineId: apiKey.machineId,
    }, { status: 201 });
  } catch (error) {
    console.log("Error creating key:", error);
    return NextResponse.json({ error: "Failed to create key" }, { status: 500 });
  }
}
