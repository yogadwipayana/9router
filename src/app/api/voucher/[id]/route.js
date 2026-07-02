import { NextResponse } from "next/server";
import { deleteVoucher } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const deleted = await deleteVoucher(id);
    if (!deleted) {
      return NextResponse.json({ error: "Voucher not found" }, { status: 404 });
    }
    return NextResponse.json({ message: "Voucher deleted" });
  } catch (error) {
    console.error("Error deleting voucher:", error);
    return NextResponse.json({ error: "Failed to delete voucher" }, { status: 500 });
  }
}
