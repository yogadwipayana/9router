import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { redeemVoucher } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function OPTIONS() {
  return adminOptionsResponse();
}

export async function POST(request) {
  return withAdminApiKey(request, async () => {
    try {
      const body = await request.json().catch(() => ({}));
      const email = typeof body.email === "string" ? decodeURIComponent(body.email).trim().toLowerCase() : "";
      if (!EMAIL_PATTERN.test(email)) {
        return adminJson({ error: "Valid email is required" }, { status: 400 });
      }
      if (!body.code || typeof body.code !== "string") {
        return adminJson({ error: "Voucher code is required" }, { status: 400 });
      }

      const { user, voucher } = await redeemVoucher(body.code, email);
      return adminJson({ user, voucher });
    } catch (error) {
      console.error("[Admin API] Failed to redeem voucher:", error);
      const status = error.message === "User budget not found" ? 404
        : (error.message === "Voucher not found" || error.message === "Voucher already redeemed") ? 400
        : 500;
      return adminJson({ error: error.message || "Failed to redeem voucher" }, { status });
    }
  });
}
