import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    owner: row.owner || null,
    userEmail: row.owner || null,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyAccessState(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  const apiKey = rowToKey(row);
  if (!apiKey) return { valid: false, reason: "not_found" };
  if (apiKey.isActive === false) return { valid: false, reason: "key_paused", apiKey };
  if (!apiKey.owner) return { valid: true, apiKey, owner: null };

  const { getOwnerBudgetState } = await import("./ownerUsersRepo.js");
  const owner = await getOwnerBudgetState(apiKey.owner);
  if (!owner.configured) return { valid: true, apiKey, owner };
  if (owner.isActive === false) return { valid: false, reason: "owner_disabled", apiKey, owner };
  if (owner.budgetUsd !== null && owner.spentUsd >= owner.budgetUsd) {
    return { valid: false, reason: "owner_budget_exhausted", apiKey, owner };
  }

  return { valid: true, apiKey, owner };
}

export async function createApiKey(name, machineId, owner = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const normalizedOwner = typeof owner === "string" ? owner.trim().toLowerCase() : null;
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    owner: normalizedOwner || null,
    userEmail: normalizedOwner || null,
    isActive: true,
    createdAt: new Date().toISOString(),
  };
  db.run(
    `INSERT INTO apiKeys(id, key, name, owner, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.owner, apiKey.machineId, 1, apiKey.createdAt]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, owner = ?, machineId = ?, isActive = ? WHERE id = ?`,
      [merged.key, merged.name, merged.owner || null, merged.machineId, merged.isActive ? 1 : 0, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const state = await getApiKeyAccessState(key);
  return state.valid;
}
