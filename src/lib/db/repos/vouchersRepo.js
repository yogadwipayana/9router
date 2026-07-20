import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getPrisma, usePostgresOperationalData } from "../../prisma.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

function assertPostgres() {
  if (!usePostgresOperationalData()) {
    throw new Error("Vouchers require a PostgreSQL database (set DATABASE_URL)");
  }
}

function normalizeCode(code) {
  return typeof code === "string" ? code.trim().toUpperCase() : "";
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function generateCode() {
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < CODE_GROUP_LEN; i += 1) {
      group += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return `V-${groups.join("-")}`;
}

/** Products a voucher can top up. See the `kind` note on the Prisma model. */
export const VOUCHER_KINDS = ["ai", "sms"];

function normalizeKind(kind) {
  const value = typeof kind === "string" ? kind.trim().toLowerCase() : "";
  return VOUCHER_KINDS.includes(value) ? value : "ai";
}

function toVoucher(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    kind: row.kind || "ai",
    amountUsd: Number(row.amountUsd || 0),
    amountIdr: Number(row.amountIdr || 0),
    status: row.status,
    redeemedBy: row.redeemedBy || null,
    redeemedAt: row.redeemedAt || null,
    note: row.note || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getVouchers() {
  assertPostgres();
  const rows = await getPrisma().voucher.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(toVoucher);
}

export async function getVoucherByCode(code) {
  assertPostgres();
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const row = await getPrisma().voucher.findUnique({ where: { code: normalized } });
  return toVoucher(row);
}

/**
 * Create one voucher. `kind` decides which amount matters: "ai" reads
 * `amountUsd`, "sms" reads `amountIdr`. The other column stays 0 so a voucher
 * can never be spent against the wrong product.
 */
export async function createVoucher({ kind, amountUsd, amountIdr, note } = {}) {
  assertPostgres();
  const voucherKind = normalizeKind(kind);
  const amount = Number(voucherKind === "sms" ? amountIdr : amountUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be greater than zero");
  }

  const prisma = getPrisma();
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const row = await prisma.voucher.create({
        data: {
          id: uuidv4(),
          code: generateCode(),
          kind: voucherKind,
          amountUsd: voucherKind === "ai" ? amount : 0,
          amountIdr: voucherKind === "sms" ? amount : 0,
          status: "active",
          redeemedBy: null,
          redeemedAt: null,
          note: note?.trim() || null,
          createdAt: now,
          updatedAt: now,
        },
      });
      return toVoucher(row);
    } catch (err) {
      // P2002 = unique constraint violation (code collision) → retry
      if (err?.code === "P2002" && attempt < 4) continue;
      throw err;
    }
  }
}

export async function deleteVoucher(id) {
  assertPostgres();
  const res = await getPrisma().voucher.deleteMany({ where: { id } });
  return res.count > 0;
}

export async function deleteVouchers(ids) {
  assertPostgres();
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : [];
  if (list.length === 0) return 0;
  const res = await getPrisma().voucher.deleteMany({ where: { id: { in: list } } });
  return res.count;
}

export async function redeemVoucher(code, email) {
  assertPostgres();
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) throw new Error("Voucher not found");
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("User budget not found");

  const prisma = getPrisma();
  const now = new Date().toISOString();

  const { voucher, user } = await prisma.$transaction(async (tx) => {
    const owner = await tx.ownerUser.findUnique({ where: { email: normalizedEmail } });
    if (!owner) throw new Error("User budget not found");

    const row = await tx.voucher.findUnique({ where: { code: normalizedCode } });
    if (!row) throw new Error("Voucher not found");
    // An SMS voucher carries no USD value — redeeming it here would credit $0
    // and burn the code. Reject it so the holder can claim it where it counts.
    if ((row.kind || "ai") !== "ai") throw new Error("Voucher is not an AI Router voucher");
    if (row.status !== "active") throw new Error("Voucher already redeemed");

    // Atomic claim: only flips if still active, guarding against double-redeem.
    const claim = await tx.voucher.updateMany({
      where: { code: normalizedCode, status: "active" },
      data: { status: "redeemed", redeemedBy: normalizedEmail, redeemedAt: now, updatedAt: now },
    });
    if (claim.count !== 1) throw new Error("Voucher already redeemed");

    const nextBudget = Number(owner.budgetUsd || 0) + Number(row.amountUsd || 0);
    await tx.ownerUser.update({
      where: { email: normalizedEmail },
      data: { budgetUsd: nextBudget, updatedAt: now },
    });

    const claimed = await tx.voucher.findUnique({ where: { code: normalizedCode } });
    return { voucher: toVoucher(claimed), user: { email: normalizedEmail, budgetUsd: nextBudget } };
  });

  const { getOwnerBudgetState } = await import("./ownerUsersRepo.js");
  const state = await getOwnerBudgetState(normalizedEmail);
  return { voucher, user: state || user };
}

/**
 * Claim an SMS voucher for `email` and hand back its rupiah value.
 *
 * Unlike `redeemVoucher`, nothing here touches a budget: the balance lives in
 * the caller's own database. This only flips the code to "redeemed" so it can
 * never be claimed twice, and the caller credits its wallet afterwards. If that
 * credit fails, the caller must call `releaseVoucher` to hand the code back.
 *
 * No ownerUser row is required — an SMS buyer may never have used the router.
 */
export async function claimVoucher(code, email) {
  assertPostgres();
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) throw new Error("Voucher not found");
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("Email is required");

  const prisma = getPrisma();
  const now = new Date().toISOString();

  return prisma.$transaction(async (tx) => {
    const row = await tx.voucher.findUnique({ where: { code: normalizedCode } });
    if (!row) throw new Error("Voucher not found");
    if ((row.kind || "ai") !== "sms") throw new Error("Voucher is not an SMS voucher");
    if (row.status !== "active") throw new Error("Voucher already redeemed");

    // Atomic claim: only flips if still active, guarding against double-claim.
    const claim = await tx.voucher.updateMany({
      where: { code: normalizedCode, kind: "sms", status: "active" },
      data: { status: "redeemed", redeemedBy: normalizedEmail, redeemedAt: now, updatedAt: now },
    });
    if (claim.count !== 1) throw new Error("Voucher already redeemed");

    const claimed = await tx.voucher.findUnique({ where: { code: normalizedCode } });
    return toVoucher(claimed);
  });
}

/**
 * Undo a claim so the code can be used again.
 *
 * Scoped to the claiming email so one buyer's failed top-up can never free
 * another's voucher. Returns false when there was nothing to release, which the
 * caller should treat as "already settled" rather than an error.
 */
export async function releaseVoucher(code, email) {
  assertPostgres();
  const normalizedCode = normalizeCode(code);
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedCode || !normalizedEmail) return false;

  const now = new Date().toISOString();
  const res = await getPrisma().voucher.updateMany({
    where: {
      code: normalizedCode,
      kind: "sms",
      status: "redeemed",
      redeemedBy: normalizedEmail,
    },
    data: { status: "active", redeemedBy: null, redeemedAt: null, updatedAt: now },
  });
  return res.count > 0;
}
