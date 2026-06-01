import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, getOwnerUserByEmail, updateApiKey } from "@/lib/localDb";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/keys/[id] - Get single key
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    return NextResponse.json({ key });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;
    const emailInput = body.userEmail ?? body.owner;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;
    if (emailInput !== undefined) {
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
      updateData.owner = userEmail;
    }

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
