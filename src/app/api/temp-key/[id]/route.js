import { NextResponse } from "next/server";
import { deleteTempApiKey } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteTempApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Temp key not found" }, { status: 404 });
    }
    return NextResponse.json({ message: "Temp key deleted" });
  } catch (error) {
    console.error("Error deleting temp key:", error);
    return NextResponse.json({ error: error.message || "Failed to delete temp key" }, { status: 500 });
  }
}
