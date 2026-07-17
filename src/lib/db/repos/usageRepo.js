import { EventEmitter } from "events";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { getPrisma, usePostgresOperationalData } from "../../prisma.js";
import { ownerSpendPgAvailable, disableOwnerSpendPg } from "../helpers/ownerSpendPg.js";

function maskApiKey(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length <= 8) return key.charAt(0) + "***";
  return key.slice(0, 8) + "***";
}

const PENDING_TIMEOUT_MS = 60 * 1000;
const RING_CAP = 50;
const CONN_CACHE_TTL_MS = 30 * 1000;
const PERIOD_MS = { "24h": 86400000, "7d": 604800000, "30d": 2592000000, "60d": 5184000000 };
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// In-memory state shared across Next.js modules
if (!global._pendingRequests) global._pendingRequests = { byModel: {}, byAccount: {} };
if (!global._lastErrorProvider) global._lastErrorProvider = { provider: "", ts: 0 };
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
if (!global._pendingTimers) global._pendingTimers = {};
if (!global._recentRing) global._recentRing = { items: [], initialized: false };
if (!global._connectionMapCache) global._connectionMapCache = { map: {}, ts: 0 };
if (!global._apiKeyMapCache) global._apiKeyMapCache = { map: {}, ts: 0 };
if (!global._nodeNameMapCache) global._nodeNameMapCache = { map: {}, ts: 0 };
if (!global._statsEmitTimers) global._statsEmitTimers = { pending: null, update: null };
if (!global._usagePruneState) global._usagePruneState = { lastRunAt: 0 };

const pendingRequests = global._pendingRequests;
const lastErrorProvider = global._lastErrorProvider;
const pendingTimers = global._pendingTimers;
const recentRing = global._recentRing;
const connCache = global._connectionMapCache;
const apiKeyCache = global._apiKeyMapCache;
const nodeNameCache = global._nodeNameMapCache;
const statsEmitTimers = global._statsEmitTimers;
const usagePruneState = global._usagePruneState;

export const statsEmitter = global._statsEmitter;

function scheduleStatsEvent(event, delayMs = 150) {
  const key = event === "update" ? "update" : "pending";
  if (statsEmitTimers[key]) return;
  statsEmitTimers[key] = setTimeout(() => {
    statsEmitTimers[key] = null;
    statsEmitter.emit(event);
  }, delayMs);
  statsEmitTimers[key]?.unref?.();
}

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function normalizeOwnerEmail(email) {
  const normalized = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!EMAIL_PATTERN.test(normalized)) throw new Error("Valid email is required");
  return normalized;
}

function addToCounter(target, key, values) {
  if (!target[key]) target[key] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cachedTokens += values.cachedTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDay(day, entry) {
  const promptTokens = entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens = entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cachedTokens = entry.tokens?.cached_tokens || entry.tokens?.cache_read_input_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cachedTokens, cost };

  day.requests = (day.requests || 0) + 1;
  day.promptTokens = (day.promptTokens || 0) + promptTokens;
  day.completionTokens = (day.completionTokens || 0) + completionTokens;
  day.cachedTokens = (day.cachedTokens || 0) + cachedTokens;
  day.cost = (day.cost || 0) + cost;

  day.byProvider ||= {};
  day.byModel ||= {};
  day.byAccount ||= {};
  day.byApiKey ||= {};
  day.byEndpoint ||= {};

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider ? `${entry.model}|${entry.provider}` : entry.model;
  addToCounter(day.byModel, modelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, { ...vals, meta: { rawModel: entry.model, provider: entry.provider } });
  }

  const apiKeyVal = entry.apiKey && typeof entry.apiKey === "string" ? entry.apiKey : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, { ...vals, meta: { rawModel: entry.model, provider: entry.provider, apiKey: entry.apiKey || null } });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, { ...vals, meta: { endpoint, rawModel: entry.model, provider: entry.provider } });
}

function createEmptyDay() {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
  };
}

function rowToUsageEntry(row) {
  return {
    timestamp: row.timestamp,
    provider: row.provider,
    model: row.model,
    connectionId: row.connectionId,
    apiKey: row.apiKey,
    endpoint: row.endpoint,
    cost: row.cost,
    status: row.status,
    tokens: parseJson(row.tokens, {}),
  };
}

function buildUsageWhere(filter = {}) {
  const where = {};
  if (filter.provider) where.provider = filter.provider;
  if (filter.model) where.model = filter.model;
  if (filter.startDate || filter.endDate) {
    where.timestamp = {};
    if (filter.startDate) where.timestamp.gte = new Date(filter.startDate).toISOString();
    if (filter.endDate) where.timestamp.lte = new Date(filter.endDate).toISOString();
  }
  return where;
}

function buildTimestampWhere(startIso, endIso) {
  const timestamp = {};
  if (startIso) timestamp.gte = startIso;
  if (endIso) timestamp.lte = endIso;
  return { timestamp };
}

async function rebuildPostgresUsageDailyFromHistory(client = getPrisma()) {
  await client.usageDaily.deleteMany();
  const rows = await client.usageHistory.findMany({
    orderBy: { id: "asc" },
    select: {
      timestamp: true,
      provider: true,
      model: true,
      connectionId: true,
      apiKey: true,
      endpoint: true,
      cost: true,
      status: true,
      tokens: true,
    },
  });
  const days = new Map();

  for (const row of rows) {
    const dateKey = getLocalDateKey(row.timestamp);
    if (!days.has(dateKey)) days.set(dateKey, createEmptyDay());
    aggregateEntryToDay(days.get(dateKey), rowToUsageEntry(row));
  }

  for (const [dateKey, day] of days.entries()) {
    await client.usageDaily.create({ data: { dateKey, data: stringifyJson(day) } });
  }
}

function rebuildUsageDailyFromHistory(db) {
  db.run(`DELETE FROM usageDaily`);
  const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens FROM usageHistory ORDER BY id ASC`);
  const days = new Map();

  for (const row of rows) {
    const dateKey = getLocalDateKey(row.timestamp);
    if (!days.has(dateKey)) days.set(dateKey, createEmptyDay());
    aggregateEntryToDay(days.get(dateKey), {
      timestamp: row.timestamp,
      provider: row.provider,
      model: row.model,
      connectionId: row.connectionId,
      apiKey: row.apiKey,
      endpoint: row.endpoint,
      cost: row.cost || 0,
      status: row.status,
      tokens: parseJson(row.tokens, {}),
    });
  }

  for (const [dateKey, day] of days.entries()) {
    db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?)`, [dateKey, stringifyJson(day)]);
  }
}

function pushToRing(entry) {
  recentRing.items.push(entry);
  if (recentRing.items.length > RING_CAP) {
    recentRing.items = recentRing.items.slice(-RING_CAP);
  }
}

async function getConnectionMapCached() {
  if (Date.now() - connCache.ts < CONN_CACHE_TTL_MS) return connCache.map;
  try {
    // Connections always live in local SQLite (no Postgres path) — select only
    // the naming columns instead of parsing every connection's data blob.
    const db = await getAdapter();
    const rows = db.all(`SELECT id, name, email FROM providerConnections`);
    const map = {};
    for (const c of rows) map[c.id] = c.name || c.email || c.id;
    connCache.map = map;
    connCache.ts = Date.now();
  } catch {}
  return connCache.map;
}

async function getNodeNameMapCached() {
  if (Date.now() - nodeNameCache.ts < CONN_CACHE_TTL_MS) return nodeNameCache.map;
  try {
    const db = await getAdapter();
    const rows = db.all(`SELECT id, name FROM providerNodes`);
    const map = {};
    for (const n of rows) if (n.id && n.name) map[n.id] = n.name;
    nodeNameCache.map = map;
    nodeNameCache.ts = Date.now();
  } catch {}
  return nodeNameCache.map;
}

async function getApiKeyMapCached() {
  if (Date.now() - apiKeyCache.ts < CONN_CACHE_TTL_MS) return apiKeyCache.map;
  try {
    const { getApiKeys } = await import("./apiKeysRepo.js");
    const all = await getApiKeys();
    const map = {};
    for (const k of all) map[k.key] = { name: k.name, id: k.id, createdAt: k.createdAt, owner: k.owner || null };
    apiKeyCache.map = map;
    apiKeyCache.ts = Date.now();
  } catch {}
  return apiKeyCache.map;
}

function resolveKeyName(apiKey, apiKeyMap) {
  if (!apiKey || typeof apiKey !== "string") return "Local";
  const info = apiKeyMap[apiKey];
  return info?.name || apiKey.slice(0, 8) + "...";
}

async function ensureRingInitialized() {
  if (recentRing.initialized) return;
  recentRing.initialized = true;
  try {
    if (usePostgresOperationalData()) {
      const rows = await getPrisma().usageHistory.findMany({
        orderBy: { id: "desc" },
        take: RING_CAP,
        select: {
          timestamp: true,
          provider: true,
          model: true,
          connectionId: true,
          apiKey: true,
          endpoint: true,
          cost: true,
          status: true,
          tokens: true,
        },
      });
      recentRing.items = rows.reverse().map(rowToUsageEntry);
      return;
    }

    const db = await getAdapter();
    const rows = db.all(`SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`, [RING_CAP]);
    recentRing.items = rows.reverse().map((r) => ({
      timestamp: r.timestamp, provider: r.provider, model: r.model, connectionId: r.connectionId,
      apiKey: r.apiKey, endpoint: r.endpoint, cost: r.cost, status: r.status,
      tokens: parseJson(r.tokens, {}),
    }));
  } catch {}
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

// Optional usageHistory retention — opt-in via settings.usageRetentionDays
// (0/unset = keep forever). Runs at most once per hour, piggybacked on writes.
// Owner lifetime spend survives pruning: budgets read the incrementally-
// maintained ownerSpend table, which pruning never touches.
async function maybePruneUsageHistory() {
  const now = Date.now();
  if (now - usagePruneState.lastRunAt < PRUNE_INTERVAL_MS) return;
  usagePruneState.lastRunAt = now;

  try {
    const { getSettings } = await import("./settingsRepo.js");
    const settings = await getSettings();
    const days = Number(settings.usageRetentionDays) || 0;
    if (days <= 0) return;

    const cutoffIso = new Date(now - days * 86400000).toISOString();
    if (usePostgresOperationalData()) {
      const res = await getPrisma().usageHistory.deleteMany({ where: { timestamp: { lt: cutoffIso } } });
      if (res.count > 0) console.log(`[usageRepo] retention: pruned ${res.count} usageHistory rows older than ${days}d`);
      return;
    }

    const db = await getAdapter();
    const res = db.run(`DELETE FROM usageHistory WHERE timestamp < ?`, [cutoffIso]);
    if (res?.changes > 0) console.log(`[usageRepo] retention: pruned ${res.changes} usageHistory rows older than ${days}d`);
  } catch (e) {
    console.error("[usageRepo] retention prune failed:", e?.message || e);
  }
}

async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;
  try {
    const { getPricingForModel } = await import("./pricingRepo.js");
    const pricing = await getPricingForModel(provider, model);
    if (!pricing) return 0;

    // Delegate the actual math to the single source of truth (avoids the two
    // copies drifting apart — see open-sse/providers/pricing.js for the
    // cache-inclusive prompt_tokens convention this assumes).
    const { calculateCostFromTokens } = await import("open-sse/providers/pricing.js");
    return calculateCostFromTokens(tokens, pricing);
  } catch (e) {
    console.error("Error calculating cost:", e);
    return 0;
  }
}

export function trackPendingRequest(model, provider, connectionId, started, error = false) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(0, pendingRequests.byModel[modelKey] + (started ? 1 : -1));
  if (pendingRequests.byModel[modelKey] === 0) delete pendingRequests.byModel[modelKey];

  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId]) pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey]) pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(0, pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1));
    if (pendingRequests.byAccount[connectionId][modelKey] === 0) {
      delete pendingRequests.byAccount[connectionId][modelKey];
      if (Object.keys(pendingRequests.byAccount[connectionId]).length === 0) {
        delete pendingRequests.byAccount[connectionId];
      }
    }
  }

  if (started) {
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) pendingRequests.byModel[modelKey] = 0;
      if (connectionId && pendingRequests.byAccount[connectionId]?.[modelKey] > 0) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      scheduleStatsEvent("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  // [PENDING] console line removed; lifecycle is visible via "▶" and "📊 done" lines
  scheduleStatsEvent("pending");
}

export async function getActiveRequests() {
  const activeRequests = [];
  const connectionMap = await getConnectionMapCached();

  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  await ensureRingInitialized();
  const apiKeyMap = await getApiKeyMapCached();
  const seen = new Set();
  const recentRequests = [...recentRing.items]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp, model: e.model, provider: e.provider || "",
        apiKey: e.apiKey || null,
        keyName: resolveKeyName(e.apiKey, apiKeyMap),
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.apiKey || ""}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const errorProvider = (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "";
  // pending is included so SSE consumers can serve live-activity updates from
  // this lightweight call alone, without recomputing full usage stats.
  return { activeRequests, recentRequests, errorProvider, pending: pendingRequests };
}

export async function saveRequestUsage(entry) {
  try {
    if (!entry.timestamp) entry.timestamp = new Date().toISOString();
    entry.cost = await calculateCost(entry.provider, entry.model, entry.tokens);

    const tokens = entry.tokens || {};
    const promptTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const completionTokens = tokens.completion_tokens || tokens.output_tokens || 0;

    // Persist owner alongside apiKey so spend stays attributable after the
    // ApiKey row is deleted. If caller didn't supply owner, resolve via the
    // cached key map.
    let owner = typeof entry.owner === "string" && entry.owner.trim() ? entry.owner.trim().toLowerCase() : null;
    if (!owner && entry.apiKey) {
      try {
        const map = await getApiKeyMapCached();
        const info = map[entry.apiKey];
        if (info?.owner) owner = String(info.owner).trim().toLowerCase() || null;
      } catch {}
    }

    if (usePostgresOperationalData()) {
      const prisma = getPrisma();

      // 1) usageHistory: single-statement insert. NO interactive transaction →
      //    immune to P2028 ("Unable to start a transaction in the given time")
      //    that previously rolled back history together with the daily upsert.
      //    History is the source of truth; usageDaily can be rebuilt from it.
      await prisma.usageHistory.create({
        data: {
          timestamp: entry.timestamp,
          provider: entry.provider || null,
          model: entry.model || null,
          connectionId: entry.connectionId || null,
          apiKey: entry.apiKey || null,
          owner,
          endpoint: entry.endpoint || null,
          promptTokens,
          completionTokens,
          cost: entry.cost || 0,
          status: entry.status || "ok",
          tokens: stringifyJson(tokens),
          meta: stringifyJson({}),
        },
      });

      pushToRing(entry);
      statsEmitter.emit("update");

      // Owner spend aggregate: single-statement atomic upsert (no interactive
      // tx → immune to the P2028 issue above). Best-effort like usageDaily —
      // if it fails, budget checks fall back to SUM(usageHistory).
      if (owner && ownerSpendPgAvailable(prisma)) {
        try {
          await prisma.$executeRaw`
            INSERT INTO "ownerSpend" ("owner", "spentUsd", "requestCount", "updatedAt")
            VALUES (${owner}, ${entry.cost || 0}, 1, ${entry.timestamp})
            ON CONFLICT ("owner") DO UPDATE SET
              "spentUsd" = "ownerSpend"."spentUsd" + EXCLUDED."spentUsd",
              "requestCount" = "ownerSpend"."requestCount" + 1,
              "updatedAt" = EXCLUDED."updatedAt"
          `;
        } catch (e) {
          disableOwnerSpendPg(e);
        }
      }

      // 2) usageDaily: best-effort aggregate update in its own short tx with
      //    generous maxWait so a busy pgbouncer pool doesn't blow up. If it
      //    still fails, history is intact and the daily summary will catch up
      //    on the next successful write or via rebuildPostgresUsageDailyFromHistory.
      try {
        const dateKey = getLocalDateKey(entry.timestamp);
        await prisma.$transaction(
          async (tx) => {
            const row = await tx.usageDaily.findUnique({ where: { dateKey } });
            const day = row ? parseJson(row.data, {}) : createEmptyDay();
            aggregateEntryToDay(day, entry);
            await tx.usageDaily.upsert({
              where: { dateKey },
              create: { dateKey, data: stringifyJson(day) },
              update: { data: stringifyJson(day) },
            });
          },
          { maxWait: 15_000, timeout: 20_000 }
        );
      } catch (e) {
        console.error("Failed to update usageDaily aggregate (history saved OK):", e?.code || e?.message || e);
      }

      maybePruneUsageHistory().catch(() => {});
      return;
    }

    const db = await getAdapter();
    let inserted = false;

    // Deterministic dedup key over the same 7 fields the old SELECT probe
    // matched. Enforced by UNIQUE idx_uh_dedup → INSERT OR IGNORE replaces the
    // per-insert 7-column COALESCE lookup.
    const dedupHash = [
      entry.timestamp, entry.provider || "", entry.model || "",
      entry.connectionId || "", entry.apiKey || "",
      promptTokens, completionTokens,
    ].join("|");

    // All 3 writes (history insert, daily upsert, lifetime counter) in ONE transaction.
    // better-sqlite3 is sync → no JS yield mid-transaction → no race in same process.
    db.transaction(() => {
      const res = db.run(
        `INSERT OR IGNORE INTO usageHistory(timestamp, provider, model, connectionId, apiKey, owner, endpoint, promptTokens, completionTokens, cost, status, tokens, meta, dedupHash) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.timestamp, entry.provider || null, entry.model || null,
          entry.connectionId || null, entry.apiKey || null, owner, entry.endpoint || null,
          promptTokens, completionTokens, entry.cost || 0, entry.status || "ok",
          stringifyJson(tokens), stringifyJson({}), dedupHash,
        ]
      );

      if (!res?.changes) {
        // Duplicate delivery — keep the legacy behavior of backfilling endpoint
        if (entry.endpoint) {
          db.run(
            `UPDATE usageHistory SET endpoint = ? WHERE dedupHash = ? AND (endpoint IS NULL OR endpoint = '')`,
            [entry.endpoint, dedupHash]
          );
        }
        return;
      }

      const dateKey = getLocalDateKey(entry.timestamp);
      const row = db.get(`SELECT data FROM usageDaily WHERE dateKey = ?`, [dateKey]);
      const day = row ? parseJson(row.data, {}) : createEmptyDay();
      aggregateEntryToDay(day, entry);
      db.run(`INSERT INTO usageDaily(dateKey, data) VALUES(?, ?) ON CONFLICT(dateKey) DO UPDATE SET data = excluded.data`, [dateKey, stringifyJson(day)]);

      // Owner spend aggregate — same transaction as the history insert, so the
      // budget counter can never drift from what actually landed in history.
      if (owner) {
        db.run(
          `INSERT INTO ownerSpend(owner, spentUsd, requestCount, updatedAt) VALUES(?, ?, 1, ?)
           ON CONFLICT(owner) DO UPDATE SET
             spentUsd = spentUsd + excluded.spentUsd,
             requestCount = requestCount + 1,
             updatedAt = excluded.updatedAt`,
          [owner, entry.cost || 0, entry.timestamp]
        );
      }

      // Atomic counter increment in same transaction
      const cur = db.get(`SELECT value FROM _meta WHERE key = 'totalRequestsLifetime'`);
      const next = (cur ? parseInt(cur.value, 10) : 0) + 1;
      db.run(`INSERT INTO _meta(key, value) VALUES('totalRequestsLifetime', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [String(next)]);
      inserted = true;
    });

    if (inserted) {
      pushToRing(entry);
      scheduleStatsEvent("update", 250);
    }

    maybePruneUsageHistory().catch(() => {});
  } catch (e) {
    console.error("Failed to save usage stats:", e);
  }
}

const HISTORY_DEFAULT_LIMIT = 500;
const HISTORY_MAX_LIMIT = 5000;

// Paginated: pages walk backwards from the newest row (offset 0 = most recent
// `limit` rows), but each page is returned oldest-first to keep the historical
// ORDER BY id ASC contract for consumers that iterate chronologically.
export async function getUsageHistory(filter = {}) {
  const limit = Math.min(Math.max(parseInt(filter.limit, 10) || HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT);
  const offset = Math.max(parseInt(filter.offset, 10) || 0, 0);

  if (usePostgresOperationalData()) {
    const rows = await getPrisma().usageHistory.findMany({
      where: buildUsageWhere(filter),
      orderBy: { id: "desc" },
      take: limit,
      skip: offset,
      select: {
        timestamp: true,
        provider: true,
        model: true,
        connectionId: true,
        apiKey: true,
        endpoint: true,
        cost: true,
        status: true,
        tokens: true,
      },
    });
    return rows.reverse().map(rowToUsageEntry);
  }

  const db = await getAdapter();
  const conds = [];
  const params = [];

  if (filter.provider) { conds.push("provider = ?"); params.push(filter.provider); }
  if (filter.model) { conds.push("model = ?"); params.push(filter.model); }
  if (filter.startDate) { conds.push("timestamp >= ?"); params.push(new Date(filter.startDate).toISOString()); }
  if (filter.endDate) { conds.push("timestamp <= ?"); params.push(new Date(filter.endDate).toISOString()); }

  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = db.all(
    `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, cost, status, tokens FROM usageHistory ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  rows.reverse();

  return rows.map((r) => ({
    timestamp: r.timestamp, provider: r.provider, model: r.model,
    connectionId: r.connectionId, apiKeyMasked: maskApiKey(r.apiKey), endpoint: r.endpoint,
    cost: r.cost, status: r.status, tokens: parseJson(r.tokens, {}),
  }));
}

async function loadDaysInRange(adapter, maxDays) {
  if (usePostgresOperationalData()) {
    if (maxDays == null) {
      return await getPrisma().usageDaily.findMany();
    }
    const today = new Date();
    const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
    const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
    return await getPrisma().usageDaily.findMany({ where: { dateKey: { gte: cutoffKey } } });
  }

  if (maxDays == null) {
    return adapter.all(`SELECT dateKey, data FROM usageDaily`);
  }
  const today = new Date();
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - maxDays + 1);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  return adapter.all(`SELECT dateKey, data FROM usageDaily WHERE dateKey >= ?`, [cutoffKey]);
}

export async function getUsageStats(period = "all") {
  const db = await getAdapter();
  const usingPostgres = usePostgresOperationalData();
  const prisma = usingPostgres ? getPrisma() : null;

  // Lookup maps are TTL-cached (30s) — the dashboard polls this endpoint, so
  // reloading connections/apiKeys/nodes fresh on every call was pure overhead.
  const [connectionMap, apiKeyMap, providerNodeNameMap] = await Promise.all([
    getConnectionMapCached(),
    getApiKeyMapCached(),
    getNodeNameMapCached(),
  ]);

  // recentRequests from live history (last 100 entries enough for 20 deduped)
  const recentRows = usingPostgres
    ? await prisma.usageHistory.findMany({
      orderBy: { id: "desc" },
      take: 100,
      select: { timestamp: true, provider: true, model: true, apiKey: true, tokens: true, status: true },
    })
    : db.all(`SELECT timestamp, provider, model, apiKey, tokens, status FROM usageHistory ORDER BY id DESC LIMIT 100`);
  const seen = new Set();
  const recentRequests = recentRows
    .map((r) => {
      const t = parseJson(r.tokens, {}) || {};
      return {
        timestamp: r.timestamp, model: r.model, provider: r.provider || "",
        apiKey: r.apiKey || null,
        keyName: resolveKeyName(r.apiKey, apiKeyMap),
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        cachedTokens: t.cached_tokens || t.cache_read_input_tokens || 0,
        status: r.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.apiKey || ""}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const stats = {
    totalRequests: 0,
    totalPromptTokens: 0, totalCompletionTokens: 0, totalCachedTokens: 0, totalCost: 0,
    byProvider: {}, byModel: {}, byAccount: {}, byApiKey: {}, byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider: (Date.now() - lastErrorProvider.ts < 10000) ? lastErrorProvider.provider : "",
  };

  // Active requests
  for (const [connectionId, models] of Object.entries(pendingRequests.byAccount)) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName = connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName, count,
        });
      }
    }
  }

  // last10Minutes — query 10min window
  const now = new Date();
  const currentMinuteStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const ts = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[ts] = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
    stats.last10Minutes.push(bucketMap[ts]);
  }
  const recent10 = usingPostgres
    ? await prisma.usageHistory.findMany({
      where: buildTimestampWhere(tenMinutesAgo.toISOString(), now.toISOString()),
      select: { timestamp: true, promptTokens: true, completionTokens: true, cost: true },
    })
    : db.all(
      `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ? AND timestamp <= ?`,
      [tenMinutesAgo.toISOString(), now.toISOString()]
    );
  for (const r of recent10) {
    const tt = new Date(r.timestamp).getTime();
    const minuteStart = Math.floor(tt / 60000) * 60000;
    if (bucketMap[minuteStart]) {
      bucketMap[minuteStart].requests++;
      bucketMap[minuteStart].promptTokens += r.promptTokens || 0;
      bucketMap[minuteStart].completionTokens += r.completionTokens || 0;
      bucketMap[minuteStart].cost += r.cost || 0;
    }
  }

  const useDailySummary = period !== "24h" && period !== "today";

  if (useDailySummary) {
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null;
    const dayRows = await loadDaysInRange(db, maxDays);

    for (const dr of dayRows) {
      const dateKey = dr.dateKey;
      const day = parseJson(dr.data, {});
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCachedTokens += day.cachedTokens || 0;
      stats.totalCost += day.cost || 0;

      for (const [prov, p] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov]) stats.byProvider[prov] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
        stats.byProvider[prov].requests += p.requests || 0;
        stats.byProvider[prov].promptTokens += p.promptTokens || 0;
        stats.byProvider[prov].completionTokens += p.completionTokens || 0;
        stats.byProvider[prov].cachedTokens += p.cachedTokens || 0;
        stats.byProvider[prov].cost += p.cost || 0;
      }

      for (const [mk, m] of Object.entries(day.byModel || {})) {
        const rawModel = m.rawModel || mk.split("|")[0];
        const provider = m.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byModel[statsKey].requests += m.requests || 0;
        stats.byModel[statsKey].promptTokens += m.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += m.completionTokens || 0;
        stats.byModel[statsKey].cachedTokens += m.cachedTokens || 0;
        stats.byModel[statsKey].cost += m.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || "")) stats.byModel[statsKey].lastUsed = dateKey;
      }

      for (const [connId, a] of Object.entries(day.byAccount || {})) {
        const accountName = connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = a.rawModel || "";
        const provider = a.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, connectionId: connId, accountName, lastUsed: dateKey };
        }
        stats.byAccount[accountKey].requests += a.requests || 0;
        stats.byAccount[accountKey].promptTokens += a.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens += a.completionTokens || 0;
        stats.byAccount[accountKey].cachedTokens += a.cachedTokens || 0;
        stats.byAccount[accountKey].cost += a.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || "")) stats.byAccount[accountKey].lastUsed = dateKey;
      }

      for (const [akKey, ak] of Object.entries(day.byApiKey || {})) {
        const rawModel = ak.rawModel || "";
        const provider = ak.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const apiKeyVal = ak.apiKey;
        const keyInfo = apiKeyVal ? apiKeyMap[apiKeyVal] : null;
        const keyName = keyInfo?.name || (apiKeyVal ? apiKeyVal.slice(0, 8) + "..." : "Local (No API Key)");
        const apiKeyMasked = maskApiKey(apiKeyVal);
        const apiKeyKey = apiKeyMasked || "local-no-key";
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey, lastUsed: dateKey };
        }
        stats.byApiKey[akKey].requests += ak.requests || 0;
        stats.byApiKey[akKey].promptTokens += ak.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += ak.completionTokens || 0;
        stats.byApiKey[akKey].cachedTokens += ak.cachedTokens || 0;
        stats.byApiKey[akKey].cost += ak.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || "")) stats.byApiKey[akKey].lastUsed = dateKey;
      }

      for (const [epKey, ep] of Object.entries(day.byEndpoint || {})) {
        const endpoint = ep.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = ep.rawModel || "";
        const provider = ep.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel, provider: providerDisplayName, lastUsed: dateKey };
        }
        stats.byEndpoint[epKey].requests += ep.requests || 0;
        stats.byEndpoint[epKey].promptTokens += ep.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens += ep.completionTokens || 0;
        stats.byEndpoint[epKey].cachedTokens += ep.cachedTokens || 0;
        stats.byEndpoint[epKey].cost += ep.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || "")) stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }

    // Overlay precise lastUsed timestamps from history. Aggregated in SQL
    // (MAX per 5-tuple) instead of streaming every row to JS — for period
    // "all" the old cutoff=0 fetch was a full-table materialization.
    const overlayCutoff = maxDays ? Date.now() - maxDays * 86400000 : 0;
    const overlayIso = new Date(overlayCutoff).toISOString();
    const histRows = usingPostgres
      ? (await prisma.usageHistory.groupBy({
        by: ["provider", "model", "connectionId", "apiKey", "endpoint"],
        where: buildTimestampWhere(overlayIso),
        _max: { timestamp: true },
      })).map((g) => ({
        provider: g.provider, model: g.model, connectionId: g.connectionId,
        apiKey: g.apiKey, endpoint: g.endpoint, timestamp: g._max.timestamp,
      }))
      : db.all(
        `SELECT provider, model, connectionId, apiKey, endpoint, MAX(timestamp) AS timestamp
         FROM usageHistory WHERE timestamp >= ?
         GROUP BY provider, model, connectionId, apiKey, endpoint`,
        [overlayIso]
      );
    for (const e of histRows) {
      const ts = e.timestamp;
      const modelKey = e.provider ? `${e.model} (${e.provider})` : e.model;
      if (stats.byModel[modelKey] && new Date(ts) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = ts;

      if (e.connectionId) {
        const accountName = connectionMap[e.connectionId] || `Account ${e.connectionId.slice(0, 8)}...`;
        const accountKey = `${e.model} (${e.provider} - ${accountName})`;
        if (stats.byAccount[accountKey] && new Date(ts) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = ts;
      }

      const apiKeyKey = (e.apiKey && typeof e.apiKey === "string")
        ? `${e.apiKey}|${e.model}|${e.provider || "unknown"}`
        : "local-no-key";
      if (stats.byApiKey[apiKeyKey] && new Date(ts) > new Date(stats.byApiKey[apiKeyKey].lastUsed)) stats.byApiKey[apiKeyKey].lastUsed = ts;

      const endpoint = e.endpoint || "Unknown";
      const endpointKey = `${endpoint}|${e.model}|${e.provider || "unknown"}`;
      if (stats.byEndpoint[endpointKey] && new Date(ts) > new Date(stats.byEndpoint[endpointKey].lastUsed)) stats.byEndpoint[endpointKey].lastUsed = ts;
    }
  } else {
    // 24h / today: live history
    let cutoff;
    if (period === "today") {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      cutoff = startOfDay.toISOString();
    } else {
      cutoff = new Date(Date.now() - PERIOD_MS["24h"]).toISOString();
    }
    // Fast path (SQLite): aggregate in SQL grouped by the full display tuple —
    // rows transferred drop from one-per-request to one-per-distinct-combo.
    // cachedTokens (and the legacy token fallbacks) live inside the tokens
    // JSON blob, so this needs the JSON1 functions; if the active adapter
    // lacks them (or a blob is malformed), fall back to the JS aggregation.
    let grouped = null;
    if (!usingPostgres) {
      try {
        grouped = db.all(
          `SELECT provider, model, connectionId, apiKey, endpoint,
             COUNT(*) AS requests,
             SUM(COALESCE(NULLIF(promptTokens, 0), CAST(json_extract(tokens, '$.prompt_tokens') AS INTEGER), CAST(json_extract(tokens, '$.input_tokens') AS INTEGER), 0)) AS promptTokens,
             SUM(COALESCE(NULLIF(completionTokens, 0), CAST(json_extract(tokens, '$.completion_tokens') AS INTEGER), CAST(json_extract(tokens, '$.output_tokens') AS INTEGER), 0)) AS completionTokens,
             SUM(COALESCE(CAST(json_extract(tokens, '$.cached_tokens') AS INTEGER), CAST(json_extract(tokens, '$.cache_read_input_tokens') AS INTEGER), 0)) AS cachedTokens,
             SUM(COALESCE(cost, 0)) AS cost,
             MAX(timestamp) AS lastUsed
           FROM usageHistory WHERE timestamp >= ?
           GROUP BY provider, model, connectionId, apiKey, endpoint`,
          [cutoff]
        );
      } catch { grouped = null; }
    }

    if (grouped === null) {
      const filtered = usingPostgres
        ? await prisma.usageHistory.findMany({
          where: buildTimestampWhere(cutoff),
          select: {
            timestamp: true,
            provider: true,
            model: true,
            connectionId: true,
            apiKey: true,
            endpoint: true,
            promptTokens: true,
            completionTokens: true,
            cost: true,
            tokens: true,
          },
        })
        : db.all(
          `SELECT timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, tokens FROM usageHistory WHERE timestamp >= ?`,
          [cutoff]
        );
      grouped = filtered.map((r) => {
        const tokens = parseJson(r.tokens, {}) || {};
        // Prefer pre-normalized DB columns; fall back to JSON blob (handles both prompt_tokens and input_tokens)
        return {
          provider: r.provider, model: r.model, connectionId: r.connectionId,
          apiKey: r.apiKey, endpoint: r.endpoint,
          requests: 1,
          promptTokens: r.promptTokens || tokens.prompt_tokens || tokens.input_tokens || 0,
          completionTokens: r.completionTokens || tokens.completion_tokens || tokens.output_tokens || 0,
          cachedTokens: tokens.cached_tokens || tokens.cache_read_input_tokens || 0,
          cost: r.cost || 0,
          lastUsed: r.timestamp,
        };
      });
    }

    for (const r of grouped) {
      const requests = r.requests || 1;
      const promptTokens = r.promptTokens || 0;
      const completionTokens = r.completionTokens || 0;
      const cachedTokens = r.cachedTokens || 0;
      const entryCost = r.cost || 0;
      const providerDisplayName = providerNodeNameMap[r.provider] || r.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCachedTokens += cachedTokens;
      stats.totalCost += entryCost;

      if (!stats.byProvider[r.provider]) stats.byProvider[r.provider] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
      stats.byProvider[r.provider].requests += requests;
      stats.byProvider[r.provider].promptTokens += promptTokens;
      stats.byProvider[r.provider].completionTokens += completionTokens;
      stats.byProvider[r.provider].cachedTokens += cachedTokens;
      stats.byProvider[r.provider].cost += entryCost;

      const modelKey = r.provider ? `${r.model} (${r.provider})` : r.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, lastUsed: r.lastUsed };
      }
      stats.byModel[modelKey].requests += requests;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cachedTokens += cachedTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (new Date(r.lastUsed) > new Date(stats.byModel[modelKey].lastUsed)) stats.byModel[modelKey].lastUsed = r.lastUsed;

      if (r.connectionId) {
        const accountName = connectionMap[r.connectionId] || `Account ${r.connectionId.slice(0, 8)}...`;
        const accountKey = `${r.model} (${r.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, connectionId: r.connectionId, accountName, lastUsed: r.lastUsed };
        }
        stats.byAccount[accountKey].requests += requests;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cachedTokens += cachedTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (new Date(r.lastUsed) > new Date(stats.byAccount[accountKey].lastUsed)) stats.byAccount[accountKey].lastUsed = r.lastUsed;
      }

      if (r.apiKey && typeof r.apiKey === "string") {
        const keyInfo = apiKeyMap[r.apiKey];
        const keyName = keyInfo?.name || r.apiKey.slice(0, 8) + "...";
        const apiKeyMasked = maskApiKey(r.apiKey);
        const akKey = `${apiKeyMasked}|${r.model}|${r.provider || "unknown"}`;
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked, keyName, apiKeyKey: apiKeyMasked, lastUsed: r.lastUsed };
        }
        const ake = stats.byApiKey[akKey];
        ake.requests += requests; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.lastUsed) > new Date(ake.lastUsed)) ake.lastUsed = r.lastUsed;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, rawModel: r.model, provider: providerDisplayName, apiKeyMasked: null, keyName: "Local (No API Key)", apiKeyKey: "local-no-key", lastUsed: r.lastUsed };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests += requests; ake.promptTokens += promptTokens; ake.completionTokens += completionTokens; ake.cachedTokens += cachedTokens; ake.cost += entryCost;
        if (new Date(r.lastUsed) > new Date(ake.lastUsed)) ake.lastUsed = r.lastUsed;
      }

      const endpoint = r.endpoint || "Unknown";
      const epKey = `${endpoint}|${r.model}|${r.provider || "unknown"}`;
      if (!stats.byEndpoint[epKey]) {
        stats.byEndpoint[epKey] = { requests: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0, endpoint, rawModel: r.model, provider: providerDisplayName, lastUsed: r.lastUsed };
      }
      const epe = stats.byEndpoint[epKey];
      epe.requests += requests; epe.promptTokens += promptTokens; epe.completionTokens += completionTokens; epe.cachedTokens += cachedTokens; epe.cost += entryCost;
      if (new Date(r.lastUsed) > new Date(epe.lastUsed)) epe.lastUsed = r.lastUsed;
    }
  }

  stats.totalRequests = Object.values(stats.byProvider).reduce((sum, p) => sum + (p.requests || 0), 0);
  return stats;
}

export async function getChartData(period = "7d") {
  const db = await getAdapter();
  const usingPostgres = usePostgresOperationalData();
  const prisma = usingPostgres ? getPrisma() : null;
  const now = Date.now();

  if (period === "today") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startTime = startOfDay.getTime();
    const endTime = startTime + bucketCount * bucketMs;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0 }));

    const rows = usingPostgres
      ? await prisma.usageHistory.findMany({
        where: buildTimestampWhere(new Date(startTime).toISOString()),
        select: { timestamp: true, promptTokens: true, completionTokens: true, cost: true },
      })
      : db.all(
        `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
        [new Date(startTime).toISOString()]
      );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t >= endTime) continue;
      const idx = Math.floor((t - startTime) / bucketMs);
      if (idx >= 0 && idx < bucketCount) {
        buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
        buckets[idx].cost += r.cost || 0;
      }
    }
    return buckets;
  }

  if (period === "24h") {
    const bucketCount = 24;
    const bucketMs = 3600000;
    const labelFn = (ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const startTime = now - bucketCount * bucketMs;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ label: labelFn(startTime + i * bucketMs), tokens: 0, cost: 0 }));

    const rows = usingPostgres
      ? await prisma.usageHistory.findMany({
        where: buildTimestampWhere(new Date(startTime).toISOString()),
        select: { timestamp: true, promptTokens: true, completionTokens: true, cost: true },
      })
      : db.all(
        `SELECT timestamp, promptTokens, completionTokens, cost FROM usageHistory WHERE timestamp >= ?`,
        [new Date(startTime).toISOString()]
      );
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (t < startTime || t > now) continue;
      const idx = Math.min(Math.floor((t - startTime) / bucketMs), bucketCount - 1);
      buckets[idx].tokens += (r.promptTokens || 0) + (r.completionTokens || 0);
      buckets[idx].cost += r.cost || 0;
    }
    return buckets;
  }

  let bucketCount = period === "7d" ? 7 : period === "30d" ? 30 : 60;
  const today = new Date();
  const labelFn = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  // Build map of dateKey → day data. "all" loads every daily summary and
  // spans one bucket per day from the earliest recorded day through today.
  const dayRows = await loadDaysInRange(db, period === "all" ? null : bucketCount);
  const dayMap = {};
  for (const r of dayRows) dayMap[r.dateKey] = parseJson(r.data, {});

  if (period === "all") {
    const keys = Object.keys(dayMap).sort();
    if (keys.length) {
      const [y, m, d] = keys[0].split("-").map(Number);
      const earliest = new Date(y, m - 1, d);
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      // Math.round absorbs DST hour shifts in the local-date diff
      bucketCount = Math.max(1, Math.round((startOfToday - earliest) / 86400000) + 1);
    } else {
      bucketCount = 7;
    }
  }

  return Array.from({ length: bucketCount }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (bucketCount - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const dayData = dayMap[dateKey];
    return {
      label: labelFn(d),
      tokens: dayData ? (dayData.promptTokens || 0) + (dayData.completionTokens || 0) : 0,
      cost: dayData ? (dayData.cost || 0) : 0,
    };
  });
}

export async function resetUsageData() {
  if (usePostgresOperationalData()) {
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.usageHistory.deleteMany(),
      prisma.usageDaily.deleteMany(),
    ]);

    if (ownerSpendPgAvailable(prisma)) {
      try {
        await prisma.ownerSpend.deleteMany();
      } catch (e) {
        disableOwnerSpendPg(e);
      }
    }

    try {
      const db = await getAdapter();
      db.run(`DELETE FROM _meta WHERE key = 'totalRequestsLifetime'`);
    } catch {}

    recentRing.items = [];
    recentRing.initialized = true;
    lastErrorProvider.provider = "";
    lastErrorProvider.ts = 0;

    statsEmitter.emit("update");
    return;
  }

  const db = await getAdapter();

  db.transaction(() => {
    db.run(`DELETE FROM usageHistory`);
    db.run(`DELETE FROM usageDaily`);
    db.run(`DELETE FROM ownerSpend`);
    db.run(`DELETE FROM _meta WHERE key = 'totalRequestsLifetime'`);
    try {
      db.run(`DELETE FROM sqlite_sequence WHERE name = 'usageHistory'`);
    } catch {}
  });

  recentRing.items = [];
  recentRing.initialized = true;
  lastErrorProvider.provider = "";
  lastErrorProvider.ts = 0;

  statsEmitter.emit("update");
}

export async function resetUsageForOwner(email) {
  const normalized = normalizeOwnerEmail(email);
  if (usePostgresOperationalData()) {
    const prisma = getPrisma();
    const keyRows = await prisma.$queryRaw`
      SELECT "key"
      FROM "apiKeys"
      WHERE lower("owner") = ${normalized}
    `;
    const keys = keyRows.map((row) => row.key).filter(Boolean);

    if (keys.length === 0) {
      return { deleted: 0, apiKeyCount: 0 };
    }

    const deleted = await prisma.$transaction(async (tx) => {
      const result = await tx.usageHistory.deleteMany({ where: { apiKey: { in: keys } } });
      await rebuildPostgresUsageDailyFromHistory(tx);
      return result.count;
    });

    // Recompute this owner's spend aggregate from what's left (outside the tx
    // so an aggregate hiccup can't roll back the reset itself).
    if (ownerSpendPgAvailable(prisma)) {
      try {
        await prisma.$executeRaw`DELETE FROM "ownerSpend" WHERE "owner" = ${normalized}`;
        await prisma.$executeRaw`
          INSERT INTO "ownerSpend" ("owner", "spentUsd", "requestCount", "updatedAt")
          SELECT "owner", COALESCE(SUM("cost"), 0), COUNT("id")::int, ${new Date().toISOString()}
          FROM "usageHistory" WHERE "owner" = ${normalized} GROUP BY "owner"
        `;
      } catch (e) {
        disableOwnerSpendPg(e);
      }
    }

    const keySet = new Set(keys);
    recentRing.items = recentRing.items.filter((item) => !keySet.has(item.apiKey));
    recentRing.initialized = true;
    statsEmitter.emit("update");

    return { deleted, apiKeyCount: keys.length };
  }

  const db = await getAdapter();
  const keys = db.all(
    `SELECT key FROM apiKeys WHERE lower(owner) = ?`,
    [normalized]
  ).map((row) => row.key).filter(Boolean);

  if (keys.length === 0) {
    return { deleted: 0, apiKeyCount: 0 };
  }

  const placeholders = keys.map(() => "?").join(", ");
  let deleted = 0;
  db.transaction(() => {
    const result = db.run(`DELETE FROM usageHistory WHERE apiKey IN (${placeholders})`, keys);
    deleted = result?.changes ?? 0;
    rebuildUsageDailyFromHistory(db);
    // Recompute this owner's spend aggregate from the remaining history
    db.run(`DELETE FROM ownerSpend WHERE owner = ?`, [normalized]);
    db.run(
      `INSERT INTO ownerSpend(owner, spentUsd, requestCount, updatedAt)
       SELECT owner, COALESCE(SUM(cost), 0), COUNT(id), ?
       FROM usageHistory WHERE owner = ? GROUP BY owner`,
      [new Date().toISOString(), normalized]
    );
  });

  const keySet = new Set(keys);
  recentRing.items = recentRing.items.filter((item) => !keySet.has(item.apiKey));
  recentRing.initialized = true;
  statsEmitter.emit("update");

  return { deleted, apiKeyCount: keys.length };
}

function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// No-op: request log is now derived from usageHistory table on read.
export async function appendRequestLog() {}

export async function getRecentLogs(limit = 200) {
  try {
    const rows = usePostgresOperationalData()
      ? await getPrisma().usageHistory.findMany({
        orderBy: { id: "desc" },
        take: limit,
        select: {
          timestamp: true,
          provider: true,
          model: true,
          connectionId: true,
          promptTokens: true,
          completionTokens: true,
          status: true,
          tokens: true,
        },
      })
      : (await getAdapter()).all(
        `SELECT timestamp, provider, model, connectionId, promptTokens, completionTokens, status, tokens FROM usageHistory ORDER BY id DESC LIMIT ?`,
        [limit],
      );
    if (!rows.length) return [];

    const connMap = {};
    try {
      const { getProviderConnections } = await import("./connectionsRepo.js");
      const connections = await getProviderConnections();
      for (const c of connections) connMap[c.id] = c.name || c.email || "";
    } catch {}

    return rows.map((r) => {
      const ts = formatLogDate(new Date(r.timestamp));
      const p = r.provider?.toUpperCase() || "-";
      const m = r.model || "-";
      const account = connMap[r.connectionId] || (r.connectionId ? r.connectionId.slice(0, 8) : "-");
      const tk = r.tokens ? parseJson(r.tokens, {}) : {};
      const sent = r.promptTokens ?? tk.prompt_tokens ?? "-";
      const received = r.completionTokens ?? tk.completion_tokens ?? "-";
      return `${ts} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${r.status || "-"}`;
    });
  } catch (e) {
    console.error("[usageRepo] getRecentLogs failed:", e.message);
    return [];
  }
}
