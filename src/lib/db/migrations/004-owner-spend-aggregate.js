// Incrementally-maintained spend aggregate per owner (see schema.js). Seeded
// once from usageHistory; saveRequestUsage keeps it current from then on.
// ON CONFLICT DO NOTHING makes the backfill idempotent if this migration is
// ever re-entered (e.g. schemaVersion reset) — live counters are never clobbered.
// Requires migrations 002 (owner column) and 003 (lowercase owner) to have run.
export default {
  version: 4,
  name: "owner_spend_aggregate",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS ownerSpend (
      owner TEXT PRIMARY KEY,
      spentUsd REAL NOT NULL DEFAULT 0,
      requestCount INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    )`);

    db.run(
      `INSERT INTO ownerSpend(owner, spentUsd, requestCount, updatedAt)
       SELECT owner, COALESCE(SUM(cost), 0), COUNT(id), ?
       FROM usageHistory
       WHERE owner IS NOT NULL AND owner != ''
       GROUP BY owner
       ON CONFLICT(owner) DO NOTHING`,
      [new Date().toISOString()]
    );
  },
};
