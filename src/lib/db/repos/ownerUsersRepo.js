import { getAdapter } from "../driver.js";
import { getPrisma, usePostgresOperationalData } from "../../prisma.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function assertEmail(email) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalized)) throw new Error("Valid email is required");
  return normalized;
}

function normalizeBudget(value) {
  const budgetUsd = Number(value);
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
    throw new Error("Budget must be a non-negative number");
  }
  return budgetUsd;
}

function normalizeBudgetIncrement(value) {
  const amountUsd = Number(value);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("Amount must be greater than zero");
  }
  return amountUsd;
}

function rowToOwnerUser(row) {
  if (!row) return null;
  return {
    email: row.email,
    budgetUsd: Number(row.budgetUsd || 0),
    isActive: row.isActive === 1 || row.isActive === true,
    configured: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mergeOwnerStats(row, keyStats, usageStats) {
  const budgetUsd = row ? Number(row.budgetUsd || 0) : null;
  const spentUsd = Number(usageStats?.spentUsd || 0);
  const remainingUsd = budgetUsd === null ? null : Math.max(0, budgetUsd - spentUsd);

  return {
    email: row?.email || keyStats?.email || usageStats?.email,
    budgetUsd,
    spentUsd,
    remainingUsd,
    keyCount: Number(keyStats?.keyCount || 0),
    requestCount: Number(usageStats?.requestCount || 0),
    isActive: row ? row.isActive === 1 || row.isActive === true : true,
    configured: Boolean(row),
    createdAt: row?.createdAt || null,
    updatedAt: row?.updatedAt || null,
  };
}

function getKeyStats(db) {
  const rows = db.all(`
    SELECT lower(owner) AS email, COUNT(*) AS keyCount
    FROM apiKeys
    WHERE owner IS NOT NULL AND trim(owner) != ''
    GROUP BY lower(owner)
  `);
  return Object.fromEntries(rows.map((row) => [row.email, row]));
}

function getUsageStats(db) {
  const rows = db.all(`
    SELECT lower(k.owner) AS email, COUNT(h.id) AS requestCount, COALESCE(SUM(h.cost), 0) AS spentUsd
    FROM usageHistory h
    JOIN apiKeys k ON h.apiKey = k.key
    WHERE k.owner IS NOT NULL AND trim(k.owner) != ''
    GROUP BY lower(k.owner)
  `);
  return Object.fromEntries(rows.map((row) => [row.email, row]));
}

export async function getOwnerUsers() {
  if (usePostgresOperationalData()) {
    const prisma = getPrisma();
    const rows = await prisma.ownerUser.findMany({ orderBy: { email: "asc" } });
    const byEmail = Object.fromEntries(rows.map((row) => [row.email, row]));
    const keyStatsRows = await prisma.$queryRaw`
      SELECT lower("owner") AS email, COUNT(*)::int AS "keyCount"
      FROM "apiKeys"
      WHERE "owner" IS NOT NULL AND btrim("owner") != ''
      GROUP BY lower("owner")
    `;
    const usageStatsRows = await prisma.$queryRaw`
      SELECT lower(k."owner") AS email, COUNT(h."id")::int AS "requestCount", COALESCE(SUM(h."cost"), 0)::float8 AS "spentUsd"
      FROM "usageHistory" h
      JOIN "apiKeys" k ON h."apiKey" = k."key"
      WHERE k."owner" IS NOT NULL AND btrim(k."owner") != ''
      GROUP BY lower(k."owner")
    `;
    const keyStats = Object.fromEntries(keyStatsRows.map((row) => [row.email, row]));
    const usageStats = Object.fromEntries(usageStatsRows.map((row) => [row.email, row]));

    const emails = new Set([
      ...Object.keys(byEmail),
      ...Object.keys(keyStats),
      ...Object.keys(usageStats),
    ]);

    return [...emails]
      .sort((a, b) => a.localeCompare(b))
      .map((email) => mergeOwnerStats(byEmail[email], keyStats[email], usageStats[email]));
  }

  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM ownerUsers ORDER BY email ASC`);
  const byEmail = Object.fromEntries(rows.map((row) => [row.email, row]));
  const keyStats = getKeyStats(db);
  const usageStats = getUsageStats(db);

  const emails = new Set([
    ...Object.keys(byEmail),
    ...Object.keys(keyStats),
    ...Object.keys(usageStats),
  ]);

  return [...emails]
    .sort((a, b) => a.localeCompare(b))
    .map((email) => mergeOwnerStats(byEmail[email], keyStats[email], usageStats[email]));
}

export async function getOwnerUserByEmail(email) {
  const normalized = assertEmail(email);
  if (usePostgresOperationalData()) {
    const row = await getPrisma().ownerUser.findUnique({ where: { email: normalized } });
    return rowToOwnerUser(row);
  }

  const db = await getAdapter();
  const row = db.get(`SELECT * FROM ownerUsers WHERE email = ?`, [normalized]);
  return rowToOwnerUser(row);
}

export async function upsertOwnerUser({ email, budgetUsd, isActive = true }) {
  const normalized = assertEmail(email);
  const budget = normalizeBudget(budgetUsd);
  const now = new Date().toISOString();

  if (usePostgresOperationalData()) {
    await getPrisma().ownerUser.upsert({
      where: { email: normalized },
      create: {
        email: normalized,
        budgetUsd: budget,
        isActive: isActive === false ? 0 : 1,
        createdAt: now,
        updatedAt: now,
      },
      update: {
        budgetUsd: budget,
        isActive: isActive === false ? 0 : 1,
        updatedAt: now,
      },
    });
    return await getOwnerUserByEmail(normalized);
  }

  const db = await getAdapter();
  db.run(
    `INSERT INTO ownerUsers(email, budgetUsd, isActive, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       budgetUsd = excluded.budgetUsd,
       isActive = excluded.isActive,
       updatedAt = excluded.updatedAt`,
    [normalized, budget, isActive === false ? 0 : 1, now, now]
  );

  return await getOwnerUserByEmail(normalized);
}

export async function addOwnerBudget(email, amountUsd) {
  const normalized = assertEmail(email);
  const amount = normalizeBudgetIncrement(amountUsd);
  const now = new Date().toISOString();

  if (usePostgresOperationalData()) {
    let exists = false;
    await getPrisma().$transaction(async (tx) => {
      const row = await tx.ownerUser.findUnique({ where: { email: normalized } });
      if (!row) return;
      exists = true;
      const nextBudget = Number(row.budgetUsd || 0) + amount;
      await tx.ownerUser.update({
        where: { email: normalized },
        data: { budgetUsd: nextBudget, updatedAt: now },
      });
    });

    if (!exists) throw new Error("User budget not found");
    return await getOwnerBudgetState(normalized);
  }

  const db = await getAdapter();
  let exists = false;
  db.transaction(() => {
    const row = db.get(`SELECT budgetUsd FROM ownerUsers WHERE email = ?`, [normalized]);
    if (!row) return;
    exists = true;
    const nextBudget = Number(row.budgetUsd || 0) + amount;
    db.run(
      `UPDATE ownerUsers SET budgetUsd = ?, updatedAt = ? WHERE email = ?`,
      [nextBudget, now, normalized]
    );
  });

  if (!exists) throw new Error("User budget not found");
  return await getOwnerBudgetState(normalized);
}

export async function deleteOwnerUser(email) {
  const normalized = assertEmail(email);
  if (usePostgresOperationalData()) {
    const res = await getPrisma().ownerUser.deleteMany({ where: { email: normalized } });
    return res.count > 0;
  }

  const db = await getAdapter();
  const res = db.run(`DELETE FROM ownerUsers WHERE email = ?`, [normalized]);
  return (res?.changes ?? 0) > 0;
}

export async function getOwnerBudgetState(email) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalized)) {
    return { configured: false, email: normalized || null, budgetUsd: null, spentUsd: 0, remainingUsd: null, isActive: true };
  }

  if (usePostgresOperationalData()) {
    const prisma = getPrisma();
    const row = await prisma.ownerUser.findUnique({ where: { email: normalized } });
    const usageRows = await prisma.$queryRaw`
      SELECT COUNT(h."id")::int AS "requestCount", COALESCE(SUM(h."cost"), 0)::float8 AS "spentUsd"
      FROM "usageHistory" h
      JOIN "apiKeys" k ON h."apiKey" = k."key"
      WHERE lower(k."owner") = ${normalized}
    `;
    return mergeOwnerStats(row, null, { email: normalized, ...(usageRows[0] || {}) });
  }

  const db = await getAdapter();
  const row = db.get(`SELECT * FROM ownerUsers WHERE email = ?`, [normalized]);
  const usage = db.get(`
    SELECT COUNT(h.id) AS requestCount, COALESCE(SUM(h.cost), 0) AS spentUsd
    FROM usageHistory h
    JOIN apiKeys k ON h.apiKey = k.key
    WHERE lower(k.owner) = ?
  `, [normalized]);

  return mergeOwnerStats(row, null, { email: normalized, ...(usage || {}) });
}
