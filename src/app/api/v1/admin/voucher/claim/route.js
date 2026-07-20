import { adminJson, adminOptionsResponse, withAdminApiKey } from "@/lib/adminApiAuth";
import { claimVoucher, releaseVoucher } from "@/lib/localDb";

export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function OPTIONS() {
  return adminOptionsResponse();
}

function readBody(body) {
  const email = typeof body.email === "string"
    ? decodeURIComponent(body.email).trim().toLowerCase()
    : "";
  const code = typeof body.code === "string" ? body.code : "";
  return { email, code };
}

/**
 * Claim an SMS voucher for a buyer and return its rupiah value.
 *
 * The router does not hold the SMS wallet — the calling app does. This endpoint
 * only guarantees the code is spent exactly once; crediting the balance is the
 * caller's job, and DELETE below undoes the claim when that credit fails.
 */
export async function POST(request) {
  return withAdminApiKey(request, async () => {
    try {
      const body = await request.json().catch(() => ({}));
      const { email, code } = readBody(body);
      if (!EMAIL_PATTERN.test(email)) {
        return adminJson({ error: "Valid email is required" }, { status: 400 });
      }
      if (!code) {
        return adminJson({ error: "Voucher code is required" }, { status: 400 });
      }

      const voucher = await claimVoucher(code, email);
      return adminJson({ voucher });
    } catch (error) {
      console.error("[Admin API] Failed to claim voucher:", error);
      const message = error.message || "Failed to claim voucher";
      const isClientError =
        message === "Voucher not found" ||
        message === "Voucher already redeemed" ||
        message === "Voucher is not an SMS voucher" ||
        message === "Email is required";
      return adminJson({ error: message }, { status: isClientError ? 400 : 500 });
    }
  });
}

/** Hand a claimed voucher back — compensating action for a failed top-up. */
export async function DELETE(request) {
  return withAdminApiKey(request, async () => {
    try {
      const body = await request.json().catch(() => ({}));
      const { email, code } = readBody(body);
      if (!EMAIL_PATTERN.test(email) || !code) {
        return adminJson({ error: "Valid email and voucher code are required" }, { status: 400 });
      }

      const released = await releaseVoucher(code, email);
      return adminJson({ released });
    } catch (error) {
      console.error("[Admin API] Failed to release voucher:", error);
      return adminJson({ error: error.message || "Failed to release voucher" }, { status: 500 });
    }
  });
}
