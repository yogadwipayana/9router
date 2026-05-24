import { NextResponse } from "next/server";
import { disableProvider, enableProvider, getDisabledProviders } from "@/lib/disabledModelsDb";

export const dynamic = "force-dynamic";

// GET /api/models/disabled-providers?providerAlias=xxx
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const disabled = await getDisabledProviders();
    if (providerAlias) {
      return NextResponse.json({ disabled: disabled[providerAlias] === true });
    }
    return NextResponse.json({ disabled });
  } catch (error) {
    console.log("Error fetching disabled providers:", error);
    return NextResponse.json({ error: "Failed to fetch disabled providers" }, { status: 500 });
  }
}

// POST /api/models/disabled-providers body: { providerAlias }
export async function POST(request) {
  try {
    const { providerAlias, providerId } = await request.json();
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias required" }, { status: 400 });
    }
    const keys = Array.from(new Set([providerAlias, providerId].filter(Boolean)));
    await Promise.all(keys.map((key) => disableProvider(key)));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error disabling provider:", error);
    return NextResponse.json({ error: "Failed to disable provider" }, { status: 500 });
  }
}

// DELETE /api/models/disabled-providers?providerAlias=xxx
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerAlias = searchParams.get("providerAlias");
    const providerId = searchParams.get("providerId");
    if (!providerAlias) {
      return NextResponse.json({ error: "providerAlias required" }, { status: 400 });
    }
    const keys = Array.from(new Set([providerAlias, providerId].filter(Boolean)));
    await Promise.all(keys.map((key) => enableProvider(key)));
    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error enabling provider:", error);
    return NextResponse.json({ error: "Failed to enable provider" }, { status: 500 });
  }
}
