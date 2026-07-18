import { NextResponse } from "next/server";
import { getTempApiKeys, createTempApiKey, deleteTempApiKeys } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const keys = await getTempApiKeys();
    return NextResponse.json({ keys });
  } catch (error) {
    console.error("Error fetching temp keys:", error);
    return NextResponse.json({ error: error.message || "Failed to fetch temp keys" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();

    const budgetUsd = Number(body.budgetUsd);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      return NextResponse.json({ error: "Budget must be greater than zero" }, { status: 400 });
    }

    const durationSeconds = Math.floor(Number(body.durationSeconds));
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return NextResponse.json({ error: "Duration must be greater than zero" }, { status: 400 });
    }

    const count = body.count === undefined ? 1 : Math.floor(Number(body.count));
    if (!Number.isFinite(count) || count < 1 || count > 100) {
      return NextResponse.json({ error: "Quantity must be between 1 and 100" }, { status: 400 });
    }

    const keys = [];
    for (let i = 0; i < count; i += 1) {
      keys.push(await createTempApiKey({
        name: body.name,
        budgetUsd,
        durationSeconds,
        note: body.note,
      }));
    }
    return NextResponse.json({ keys }, { status: 201 });
  } catch (error) {
    console.error("Error creating temp key:", error);
    return NextResponse.json({ error: error.message || "Failed to create temp key" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const body = await request.json();
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "No temp key ids provided" }, { status: 400 });
    }

    const deleted = await deleteTempApiKeys(ids);
    return NextResponse.json({ deleted });
  } catch (error) {
    console.error("Error deleting temp keys:", error);
    return NextResponse.json({ error: error.message || "Failed to delete temp keys" }, { status: 500 });
  }
}
