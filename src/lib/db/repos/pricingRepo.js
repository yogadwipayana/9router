import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";
import { getPrisma, usePostgresOperationalData } from "../../prisma.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };
let userCache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
  userCache = { value: null, expiresAt: 0 };
}

// Constants are static ESM modules — resolve the imports once instead of
// re-running the dynamic-import machinery on every calculateCost call.
let constantsPromise = null;
function loadConstants() {
  if (!constantsPromise) {
    constantsPromise = Promise.all([
      import("open-sse/providers/pricing.js"),
      import("@/shared/constants/providers.js").catch(() => null),
    ]);
  }
  return constantsPromise;
}

const FIELD_MAP_TO_DB = {
  input: "input",
  output: "output",
  cached: "cached",
  reasoning: "reasoning",
  cache_creation: "cacheCreation",
};

const FIELD_MAP_FROM_DB = {
  input: "input",
  output: "output",
  cached: "cached",
  reasoning: "reasoning",
  cacheCreation: "cache_creation",
};

function rowToPricing(row) {
  const out = {};
  for (const [dbKey, jsKey] of Object.entries(FIELD_MAP_FROM_DB)) {
    if (row[dbKey] !== null && row[dbKey] !== undefined) out[jsKey] = row[dbKey];
  }
  return out;
}

function pricingToRowData(pricing) {
  const out = {};
  for (const [jsKey, dbKey] of Object.entries(FIELD_MAP_TO_DB)) {
    if (pricing[jsKey] !== undefined) out[dbKey] = pricing[jsKey];
  }
  return out;
}

async function getUserPricingCached() {
  const now = Date.now();
  if (userCache.value && userCache.expiresAt > now) return userCache.value;
  const value = await getUserPricing();
  userCache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

async function getUserPricing() {
  if (usePostgresOperationalData()) {
    const rows = await getPrisma().pricing.findMany();
    const out = {};
    for (const row of rows) {
      if (!out[row.providerAlias]) out[row.providerAlias] = {};
      out[row.providerAlias][row.modelId] = rowToPricing(row);
    }
    return out;
  }
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricingCached();
  const [{ PROVIDER_PRICING }] = await loadConstants();
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  // Called from calculateCost on every request — serve from the same TTL cache
  // as getPricing instead of hitting the kv table each time.
  const userPricing = await getUserPricingCached();
  const [constPricing, providerConstants] = await loadConstants();
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];

  // Pricing page saves by provider alias (e.g. "cx" for "codex").
  // calculateCost passes the provider ID ("codex"), so also try the alias.
  if (provider && providerConstants) {
    const alias = providerConstants.AI_PROVIDERS?.[provider]?.alias;
    if (alias && alias !== provider && userPricing[alias]?.[model]) {
      return userPricing[alias][model];
    }
  }

  return constPricing.getPricingForModel(provider, model);
}

// Atomic merge — per-(provider, model) read-modify-write
export async function updatePricing(pricingData) {
  if (usePostgresOperationalData()) {
    const prisma = getPrisma();
    const now = new Date().toISOString();
    const ops = [];
    for (const [provider, models] of Object.entries(pricingData)) {
      for (const [modelId, pricing] of Object.entries(models)) {
        const data = pricingToRowData(pricing);
        ops.push(prisma.pricing.upsert({
          where: { providerAlias_modelId: { providerAlias: provider, modelId } },
          create: { providerAlias: provider, modelId, ...data, updatedAt: now },
          update: { ...data, updatedAt: now },
        }));
      }
    }
    if (ops.length > 0) await prisma.$transaction(ops);
    invalidate();
    return await getUserPricing();
  }

  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();

  if (usePostgresOperationalData()) {
    const prisma = getPrisma();
    if (model) {
      await prisma.pricing.deleteMany({ where: { providerAlias: provider, modelId: model } });
    } else {
      await prisma.pricing.deleteMany({ where: { providerAlias: provider } });
    }
    invalidate();
    return await getUserPricing();
  }

  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  if (usePostgresOperationalData()) {
    await getPrisma().pricing.deleteMany({});
    invalidate();
    return {};
  }
  await pricingKv.clear();
  invalidate();
  return {};
}
