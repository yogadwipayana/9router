import { NextResponse } from "next/server";
import { getUsageStats, resetRequestDetails, resetUsageData } from "@/lib/usageDb";
import { getSettings } from "@/lib/localDb";
import { checkLock, getClientIp, recordFail, recordSuccess } from "@/lib/auth/loginLimiter";
import bcrypt from "bcryptjs";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "all"]);
const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export const dynamic = "force-dynamic";

async function verifyDashboardPassword(password) {
  const settings = await getSettings();
  if (settings.password) {
    return bcrypt.compare(password, settings.password);
  }

  const initialPassword = process.env.INITIAL_PASSWORD || "123456";
  return password === initialPassword;
}

export async function POST(request) {
  try {
    const ip = getClientIp(request);
    const lock = checkLock(ip);
    if (lock.locked) {
      return NextResponse.json(
        { error: `Too many failed attempts. Try again in ${lock.retryAfter}s.` },
        { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(lock.retryAfter) } },
      );
    }

    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "today";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const password = typeof body.password === "string" ? body.password : "";

    if (!password) {
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const passwordValid = await verifyDashboardPassword(password);
    if (!passwordValid) {
      const { remainingBeforeLock } = recordFail(ip);
      const postLock = checkLock(ip);
      if (postLock.locked) {
        return NextResponse.json(
          { error: `Too many failed attempts. Try again in ${postLock.retryAfter}s.` },
          { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": String(postLock.retryAfter) } },
        );
      }
      return NextResponse.json(
        { error: `Invalid password. ${remainingBeforeLock} attempt(s) left before lockout.` },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }

    recordSuccess(ip);
    await resetRequestDetails();
    await resetUsageData();

    const stats = await getUsageStats(period);
    return NextResponse.json({ success: true, stats }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[API] Failed to reset usage:", error);
    return NextResponse.json(
      { error: "Failed to reset usage" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
