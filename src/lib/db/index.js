// Public API barrel — all DB functions
import { getAdapter } from "./driver.js";
import { stringifyJson, parseJson } from "./helpers/jsonCol.js";

// Settings
export {
  getSettings, updateSettings, isCloudEnabled, getCloudUrl, exportSettings,
} from "./repos/settingsRepo.js";

// Provider connections
export {
  getProviderConnections, getProviderConnectionById,
  createProviderConnection, updateProviderConnection,
  deleteProviderConnection, deleteProviderConnectionsByProvider,
  reorderProviderConnections, cleanupProviderConnections,
} from "./repos/connectionsRepo.js";

// Provider nodes
export {
  getProviderNodes, getProviderNodeById,
  createProviderNode, updateProviderNode, deleteProviderNode,
} from "./repos/nodesRepo.js";

// Proxy pools
export {
  getProxyPools, getProxyPoolById,
  createProxyPool, updateProxyPool, deleteProxyPool,
} from "./repos/proxyPoolsRepo.js";

// API keys
export {
  getApiKeys, getApiKeyById, getApiKeyAccessState,
  createApiKey, updateApiKey, deleteApiKey, validateApiKey,
} from "./repos/apiKeysRepo.js";

// Owner users / budgets
export {
  getOwnerUsers, getOwnerUserByEmail, upsertOwnerUser, addOwnerBudget, deleteOwnerUser, getOwnerBudgetState,
} from "./repos/ownerUsersRepo.js";

// Combos
export {
  getCombos, getComboById, getComboByName,
  createCombo, updateCombo, deleteCombo,
} from "./repos/combosRepo.js";

// Vouchers
export {
  getVouchers, getVoucherByCode, createVoucher, deleteVoucher, redeemVoucher,
} from "./repos/vouchersRepo.js";

// Aliases (model + custom + mitm)
export {
  getModelAliases, setModelAlias, deleteModelAlias,
  getCustomModels, addCustomModel, deleteCustomModel,
  getMitmAlias, setMitmAliasAll,
} from "./repos/aliasRepo.js";

// Pricing
export {
  getPricing, getPricingForModel, updatePricing, resetPricing, resetAllPricing,
} from "./repos/pricingRepo.js";

// Enabled models / providers
export {
  getEnabledModels, getEnabledByProvider, enableModels, disableModels,
  getEnabledProviders, enableProvider, disableProvider, isProviderEnabled,
} from "./repos/enabledModelsRepo.js";

// Usage
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs, resetUsageData, resetUsageForOwner,
} from "./repos/usageRepo.js";

// Request details
export {
  saveRequestDetail, getRequestDetails, getRequestDetailById, resetRequestDetails,
} from "./repos/requestDetailsRepo.js";

// Export/import full DB
export async function exportDb() {
  const db = await getAdapter();
  const [{ exportSettings }, { getApiKeys }, { getOwnerUsers }, { getEnabledModels, getEnabledProviders }] = await Promise.all([
    import("./repos/settingsRepo.js"),
    import("./repos/apiKeysRepo.js"),
    import("./repos/ownerUsersRepo.js"),
    import("./repos/enabledModelsRepo.js"),
  ]);
  const ownerUsers = (await getOwnerUsers())
    .filter((u) => u.configured !== false)
    .map((u) => ({
      email: u.email,
      budgetUsd: Number(u.budgetUsd || 0),
      isActive: u.isActive !== false,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt,
    }));

  const out = {
    settings: await exportSettings(),
    providerConnections: db.all(`SELECT * FROM providerConnections`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all(`SELECT * FROM providerNodes`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all(`SELECT * FROM proxyPools`).map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: await getApiKeys(),
    ownerUsers,
    combos: db.all(`SELECT * FROM combos`).map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {},
    customModels: [],
    mitmAlias: {},
    pricing: {},
    enabledModels: await getEnabledModels(),
    enabledProviders: await getEnabledProviders(),
  };

  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'modelAliases'`)) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'customModels'`)) out.customModels.push(parseJson(r.value));
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'mitmAlias'`)) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all(`SELECT key, value FROM kv WHERE scope = 'pricing'`)) out.pricing[r.key] = parseJson(r.value);
  return out;
}

async function importPostgresOperationalTables(payload) {
  const { getPrisma, usePostgresOperationalData } = await import("../prisma.js");
  if (!usePostgresOperationalData()) return;

  // Postgres is the source of truth for operational user data: apiKeys and
  // ownerUsers are NEVER touched by import. Pricing also stays untouched (kv
  // path), so cost history remains consistent with the active price book.
  // Only enabledModels / enabledProviders are restored on demand.
  if (payload.enabledModels === undefined && payload.enabledProviders === undefined) {
    return;
  }

  const prisma = getPrisma();
  const now = new Date().toISOString();

  const enabledModelRows = [];
  for (const [providerAlias, models] of Object.entries(payload.enabledModels || {})) {
    if (!providerAlias || !Array.isArray(models)) continue;
    for (const modelId of models) {
      if (typeof modelId !== "string" || !modelId.trim()) continue;
      enabledModelRows.push({ providerAlias, modelId: modelId.trim(), createdAt: now });
    }
  }

  const enabledProviderRows = Object.entries(payload.enabledProviders || {})
    .filter(([providerAlias, enabled]) => providerAlias && enabled === true)
    .map(([providerAlias]) => ({ providerAlias, createdAt: now }));

  await prisma.$transaction(
    async (tx) => {
      if (payload.enabledModels !== undefined) {
        await tx.enabledModel.deleteMany();
      }
      if (payload.enabledProviders !== undefined) {
        await tx.enabledProvider.deleteMany();
      }

      if (payload.enabledModels !== undefined && enabledModelRows.length > 0) {
        await tx.enabledModel.createMany({ data: enabledModelRows, skipDuplicates: true });
      }
      if (payload.enabledProviders !== undefined && enabledProviderRows.length > 0) {
        await tx.enabledProvider.createMany({ data: enabledProviderRows, skipDuplicates: true });
      }
    },
    { maxWait: 30_000, timeout: 120_000 }
  );
}

export async function importDb(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid database payload");
  }
  const db = await getAdapter();
  const { usePostgresOperationalData } = await import("../prisma.js");
  const usePostgres = usePostgresOperationalData();

  db.transaction(() => {
    // Wipe tables only when payload includes the corresponding field, so old
    // backups missing newer fields don't silently erase live operational data.
    if (payload.settings !== undefined) db.run(`DELETE FROM settings`);
    if (payload.providerConnections !== undefined) db.run(`DELETE FROM providerConnections`);
    if (payload.providerNodes !== undefined) db.run(`DELETE FROM providerNodes`);
    if (payload.proxyPools !== undefined) db.run(`DELETE FROM proxyPools`);
    if (payload.combos !== undefined) db.run(`DELETE FROM combos`);
    // Note: apiKeys, ownerUsers, and pricing are intentionally NEVER touched by
    // import. Postgres is the source of truth for operational user data; backups
    // are for settings/providers/models only. Pricing is preserved so usage cost
    // history remains consistent with the active price book.
    const kvScopes = [];
    if (payload.modelAliases !== undefined) kvScopes.push("'modelAliases'");
    if (payload.customModels !== undefined) kvScopes.push("'customModels'");
    if (payload.mitmAlias !== undefined) kvScopes.push("'mitmAlias'");
    if (payload.enabledModels !== undefined) kvScopes.push("'enabledModels'");
    if (payload.enabledProviders !== undefined) kvScopes.push("'enabledProviders'");
    if (kvScopes.length > 0) {
      db.run(`DELETE FROM kv WHERE scope IN (${kvScopes.join(", ")})`);
    }

    // Settings
    if (payload.settings) {
      db.run(`INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, [stringifyJson(payload.settings)]);
    }

    if (payload.providerConnections !== undefined) {
      for (const c of payload.providerConnections || []) {
        const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
        db.run(
          `INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }
    if (payload.providerNodes !== undefined) {
      for (const n of payload.providerNodes || []) {
        const { id, type, name, createdAt, updatedAt, ...rest } = n;
        db.run(
          `INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, type || null, name || null, stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }
    if (payload.proxyPools !== undefined) {
      for (const p of payload.proxyPools || []) {
        const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
        db.run(
          `INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [id, isActive === false ? 0 : 1, testStatus || "unknown", stringifyJson(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]
        );
      }
    }
    if (payload.combos !== undefined) {
      for (const c of payload.combos || []) {
        db.run(
          `INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)`,
          [c.id, c.name, c.kind || null, stringifyJson(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]
        );
      }
    }
    if (payload.modelAliases !== undefined) {
      for (const [a, m] of Object.entries(payload.modelAliases || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)`, [a, stringifyJson(m)]);
      }
    }
    if (payload.customModels !== undefined) {
      for (const m of payload.customModels || []) {
        const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`;
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)`, [k, stringifyJson(m)]);
      }
    }
    if (payload.mitmAlias !== undefined) {
      for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) {
        db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)`, [tool, stringifyJson(mappings || {})]);
      }
    }
    if (!usePostgres) {
      if (payload.enabledModels !== undefined) {
        for (const [provider, models] of Object.entries(payload.enabledModels || {})) {
          db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('enabledModels', ?, ?)`, [provider, stringifyJson(models || [])]);
        }
      }
      if (payload.enabledProviders !== undefined) {
        for (const [provider, enabled] of Object.entries(payload.enabledProviders || {})) {
          if (enabled === true) {
            db.run(`INSERT OR REPLACE INTO kv(scope, key, value) VALUES('enabledProviders', ?, ?)`, [provider, stringifyJson(true)]);
          }
        }
      }
    }
  });

  await importPostgresOperationalTables(payload);
  return await exportDb();
}

// Eager init helper (optional)
export async function initDb() {
  await getAdapter();
}
