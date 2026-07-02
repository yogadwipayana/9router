import { NextResponse } from "next/server";
import { getVouchers, createVoucher, deleteVouchers } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const vouchers = await getVouchers();
    return NextResponse.json({ vouchers });
  } catch (error) {
    console.error("Error fetching vouchers:", error);
    return NextResponse.json({ error: "Failed to fetch vouchers" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const amountUsd = Number(body.amountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return NextResponse.json({ error: "Amount must be greater than zero" }, { status: 400 });
    }

    const count = body.count === undefined ? 1 : Math.floor(Number(body.count));
    if (!Number.isFinite(count) || count < 1 || count > 100) {
      return NextResponse.json({ error: "Quantity must be between 1 and 100" }, { status: 400 });
    }

    const vouchers = [];
    for (let i = 0; i < count; i += 1) {
      vouchers.push(await createVoucher({ amountUsd, note: body.note }));
    }
    return NextResponse.json({ vouchers }, { status: 201 });
  } catch (error) {
    console.error("Error creating vouchers:", error);
    return NextResponse.json({ error: error.message || "Failed to create voucher" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const body = await request.json();
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (ids.length === 0) {
      return NextResponse.json({ error: "No voucher ids provided" }, { status: 400 });
    }

    const deleted = await deleteVouchers(ids);
    return NextResponse.json({ deleted });
  } catch (error) {
    console.error("Error deleting vouchers:", error);
    return NextResponse.json({ error: error.message || "Failed to delete vouchers" }, { status: 500 });
  }
}
