import { v4 as uuidv4 } from "uuid";
import { getPrisma, usePostgresOperationalData } from "../../prisma.js";

// Temporary, standalone API keys: a cost cap ($) plus a lifetime that starts on
// first use. Postgres-only (like vouchers) — enforcement no-ops on SQLite.

function assertPostgres() {
  if (!usePostgresOperationalData()) {
    throw new Error("Temp API keys require a PostgreSQL database (set DATABASE_URL)");
  }
}

// Derived, presentation-only status. The authoritative gate lives in
// getTempApiKeyAccessState; this is just for the dashboard.
function deriveStatus(row) {
  if (row.isActive === 0 || row.isActive === false) return "disabled";
  if (Number(row.spentUsd || 0) >= Number(row.budgetUsd || 0)) return "exhausted";
  if (row.expiresAt && Date.now() >= new Date(row.expiresAt).getTime()) return "expired";
  return "active";
}

function toTempKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name || null,
    budgetUsd: Number(row.budgetUsd || 0),
    spentUsd: Number(row.spentUsd || 0),
    requestCount: Number(row.requestCount || 0),
    durationSeconds: Number(row.durationSeconds || 0),
    firstUsedAt: row.firstUsedAt || null,
    expiresAt: row.expiresAt || null,
    isActive: row.isActive === 1 || row.isActive === true,
    note: row.note || null,
    status: deriveStatus(row),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getTempApiKeys() {
  assertPostgres();
  const rows = await getPrisma().tempApiKey.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map(toTempKey);
}

export async function createTempApiKey({ name, budgetUsd, durationSeconds, note } = {}) {
  assertPostgres();
  const amount = Number(budgetUsd);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Budget must be greater than zero");
  }
  const seconds = Math.floor(Number(durationSeconds));
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("Duration must be greater than zero");
  }

  const { getConsistentMachineId } = await import("@/shared/utils/machineId");
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const machineId = await getConsistentMachineId();
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const generated = generateApiKeyWithMachine(machineId);
      const row = await getPrisma().tempApiKey.create({
        data: {
          id: uuidv4(),
          key: generated.key,
          name: name?.trim() || null,
          budgetUsd: amount,
          spentUsd: 0,
          requestCount: 0,
          durationSeconds: seconds,
          firstUsedAt: null,
          expiresAt: null,
          isActive: 1,
          note: note?.trim() || null,
          createdAt: now,
          updatedAt: now,
        },
      });
      const created = toTempKey(row);
      // New key must be visible to the usage-recording path immediately.
      const { invalidateTempApiKeyCache } = await import("./usageRepo.js");
      invalidateTempApiKeyCache();
      return created;
    } catch (err) {
      // P2002 = unique constraint violation (key collision) → retry
      if (err?.code === "P2002" && attempt < 4) continue;
      throw err;
    }
  }
}

export async function deleteTempApiKey(id) {
  assertPostgres();
  const res = await getPrisma().tempApiKey.deleteMany({ where: { id } });
  if (res.count > 0) {
    const { invalidateTempApiKeyCache } = await import("./usageRepo.js");
    invalidateTempApiKeyCache();
  }
  return res.count > 0;
}

export async function deleteTempApiKeys(ids) {
  assertPostgres();
  const list = Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : [];
  if (list.length === 0) return 0;
  const res = await getPrisma().tempApiKey.deleteMany({ where: { id: { in: list } } });
  if (res.count > 0) {
    const { invalidateTempApiKeyCache } = await import("./usageRepo.js");
    invalidateTempApiKeyCache();
  }
  return res.count;
}

/**
 * Authorization gate for a temp key. Called from getApiKeyAccessState when the
 * key isn't a normal apiKey. Starts the lifetime clock on the first valid use.
 * Returns null when the key isn't a temp key at all (so the caller keeps its
 * existing not_found behavior).
 */
export async function getTempApiKeyAccessState(key) {
  if (!usePostgresOperationalData()) return null;
  const prisma = getPrisma();

  // Fail-safe: if the temp tables / generated model aren't present yet (manual
  // SQL + `prisma generate` not applied), treat as "not a temp key" so the auth
  // path falls back to its normal not_found handling instead of throwing.
  let row;
  try {
    row = await prisma.tempApiKey.findUnique({ where: { key } });
  } catch {
    return null;
  }
  if (!row) return null;

  const tempKey = toTempKey(row);
  const marker = { id: tempKey.id, key: tempKey.key, name: tempKey.name, isTemp: true, tempKeyId: tempKey.id };

  if (!tempKey.isActive) {
    return { valid: false, reason: "temp_disabled", apiKey: marker, temp: tempKey };
  }
  if (tempKey.spentUsd >= tempKey.budgetUsd) {
    return { valid: false, reason: "temp_exhausted", apiKey: marker, temp: tempKey };
  }

  // Lifetime clock starts on first use. Set it atomically (guard on firstUsedAt
  // IS NULL) so concurrent first requests don't double-start it.
  let expiresAt = tempKey.expiresAt;
  if (!tempKey.firstUsedAt) {
    const now = new Date();
    const nowIso = now.toISOString();
    const computedExpiry = new Date(now.getTime() + tempKey.durationSeconds * 1000).toISOString();
    const claim = await prisma.tempApiKey.updateMany({
      where: { id: tempKey.id, firstUsedAt: null },
      data: { firstUsedAt: nowIso, expiresAt: computedExpiry, updatedAt: nowIso },
    });
    if (claim.count === 1) {
      expiresAt = computedExpiry;
      tempKey.firstUsedAt = nowIso;
      tempKey.expiresAt = computedExpiry;
    } else {
      // Lost the race — re-read the winner's expiry.
      const fresh = await prisma.tempApiKey.findUnique({ where: { id: tempKey.id } });
      expiresAt = fresh?.expiresAt || computedExpiry;
      tempKey.expiresAt = expiresAt;
    }
  }

  if (expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
    return { valid: false, reason: "temp_expired", apiKey: marker, temp: tempKey };
  }

  return { valid: true, apiKey: marker, owner: null, temp: tempKey };
}

/**
 * Increment a temp key's spend/requestCount and append a tempUsageHistory row.
 * Best-effort: called from saveRequestUsage inside a try/catch. `entry.tempKeyId`
 * identifies the key; cost/tokens come from the usage entry.
 */
export async function recordTempKeyUsage(tempKeyId, entry) {
  if (!usePostgresOperationalData() || !tempKeyId) return;
  const prisma = getPrisma();
  const tokens = entry.tokens || {};
  const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
  const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;
  const cost = Number(entry.cost || 0);
  const timestamp = entry.timestamp || new Date().toISOString();

  // Atomic spend upsert — mirrors the ownerSpend increment convention.
  await prisma.$executeRaw`
    UPDATE "tempApiKeys"
    SET "spentUsd" = "spentUsd" + ${cost},
        "requestCount" = "requestCount" + 1,
        "updatedAt" = ${timestamp}
    WHERE "id" = ${tempKeyId}
  `;

  await prisma.tempUsageHistory.create({
    data: {
      tempKeyId,
      timestamp,
      provider: entry.provider || null,
      model: entry.model || null,
      endpoint: entry.endpoint || null,
      promptTokens,
      completionTokens,
      cost,
      status: entry.status || "ok",
      tokens: JSON.stringify(tokens),
    },
  });
}
