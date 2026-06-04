import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getPrisma, usePostgresOperationalData } from "../../prisma.js";

const SCOPE = "enabledModels";
const PROVIDER_SCOPE = "enabledProviders";

function normalizeIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(
    ids
      .filter((id) => typeof id === "string")
      .map((id) => id.trim())
      .filter(Boolean)
  )];
}

export async function getEnabledModels() {
  if (usePostgresOperationalData()) {
    const rows = await getPrisma().enabledModel.findMany({
      orderBy: [{ providerAlias: "asc" }, { modelId: "asc" }],
    });
    const out = {};
    for (const row of rows) {
      out[row.providerAlias] ||= [];
      out[row.providerAlias].push(row.modelId);
    }
    return out;
  }

  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, []);
  return out;
}

export async function getEnabledByProvider(providerAlias) {
  if (usePostgresOperationalData()) {
    const rows = await getPrisma().enabledModel.findMany({
      where: { providerAlias },
      orderBy: { modelId: "asc" },
      select: { modelId: true },
    });
    return rows.map((row) => row.modelId);
  }

  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
  return row ? (parseJson(row.value, []) || []) : [];
}

// Adds models to the enabled set (turns them ON for the given provider).
export async function enableModels(providerAlias, ids) {
  const modelIds = normalizeIds(ids);
  if (!providerAlias || modelIds.length === 0) return;

  if (usePostgresOperationalData()) {
    const now = new Date().toISOString();
    await getPrisma().enabledModel.createMany({
      data: modelIds.map((modelId) => ({ providerAlias, modelId, createdAt: now })),
      skipDuplicates: true,
    });
    return;
  }

  const db = await getAdapter();
  db.transaction(() => {
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const merged = [...new Set([...current, ...modelIds])];
    db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [SCOPE, providerAlias, stringifyJson(merged)]
    );
  });
}

// Removes models from the enabled set (turns them OFF for the given provider).
// Pass an empty/omitted ids list to remove all enabled rows for that provider.
export async function disableModels(providerAlias, ids) {
  if (!providerAlias) return;
  const modelIds = normalizeIds(ids);

  if (usePostgresOperationalData()) {
    await getPrisma().enabledModel.deleteMany({
      where: modelIds.length > 0
        ? { providerAlias, modelId: { in: modelIds } }
        : { providerAlias },
    });
    return;
  }

  const db = await getAdapter();
  db.transaction(() => {
    if (modelIds.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    const current = row ? (parseJson(row.value, []) || []) : [];
    const removeSet = new Set(modelIds);
    const next = current.filter((id) => !removeSet.has(id));
    if (next.length === 0) {
      db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, providerAlias]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [SCOPE, providerAlias, stringifyJson(next)]
      );
    }
  });
}

export async function getEnabledProviders() {
  if (usePostgresOperationalData()) {
    const rows = await getPrisma().enabledProvider.findMany({
      orderBy: { providerAlias: "asc" },
      select: { providerAlias: true },
    });
    return Object.fromEntries(rows.map((row) => [row.providerAlias, true]));
  }

  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [PROVIDER_SCOPE]);
  const out = {};
  for (const r of rows) out[r.key] = parseJson(r.value, true) !== false;
  return out;
}

export async function enableProvider(providerAlias) {
  if (!providerAlias) return;
  if (usePostgresOperationalData()) {
    await getPrisma().enabledProvider.createMany({
      data: [{ providerAlias, createdAt: new Date().toISOString() }],
      skipDuplicates: true,
    });
    return;
  }

  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [PROVIDER_SCOPE, providerAlias, stringifyJson(true)]
  );
}

export async function disableProvider(providerAlias) {
  if (!providerAlias) return;
  if (usePostgresOperationalData()) {
    await getPrisma().enabledProvider.deleteMany({ where: { providerAlias } });
    return;
  }

  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [PROVIDER_SCOPE, providerAlias]);
}

export function isProviderEnabled(enabledProviders, ...aliases) {
  return aliases.some((alias) => alias && enabledProviders?.[alias] === true);
}
