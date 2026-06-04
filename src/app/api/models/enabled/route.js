import { NextResponse } from "next/server";
import { getEnabledModels, enableModels, disableModels } from "@/lib/disabledModelsDb";

export const dynamic = "force-dynamic";

// GET /api/models/enabled?providerAlias=xxx
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const all = await getEnabledModels();
    if (providerAlias) return NextResponse.json({ ids: all[providerAlias] || [] });
    return NextResponse.json({ enabled: all });
  } catch (error) {
    console.log("Error fetching enabled models:", error);
    return NextResponse.json({ error: "Failed to fetch enabled models" }, { status: 500 });
  }
}

// POST /api/models/enabled  body: { providerAlias, ids: [...] } — turns models ON
export async function POST(request) {
  try {
    const { providerAlias, ids } = await request.json();
    if (!providerAlias || !Array.isArray(ids)) {
      return NextResponse.json({ error: "providerAlias and ids[] required" }, { status: 400 });
    }
    await enableModels(providerAlias, ids);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error enabling models:", error);
    return NextResponse.json({ error: "Failed to enable models" }, { status: 500 });
  }
}

// DELETE /api/models/enabled?providerAlias=xxx[&id=yyy] — turns models OFF
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const id = searchParams.get("id");
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias required" }, { status: 400 });
    }
    await disableModels(providerAlias, id ? [id] : []);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error disabling models:", error);
    return NextResponse.json({ error: "Failed to disable models" }, { status: 500 });
  }
}
