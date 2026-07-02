import { NextResponse } from "next/server";
import { getVouchers, createVoucher } from "@/lib/localDb";

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

    const voucher = await createVoucher({ amountUsd, note: body.note });
    return NextResponse.json({ voucher }, { status: 201 });
  } catch (error) {
    console.error("Error creating voucher:", error);
    return NextResponse.json({ error: error.message || "Failed to create voucher" }, { status: 500 });
  }
}
