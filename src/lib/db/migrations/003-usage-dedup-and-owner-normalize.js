// 1) Add usageHistory.dedupHash + UNIQUE index so saveRequestUsage can dedup
//    with INSERT OR IGNORE instead of a 7-column COALESCE probe per insert.
//    Existing rows keep dedupHash = NULL on purpose: SQLite treats NULLs as
//    distinct in a UNIQUE index, and the dedup window only ever spans rows
//    written after this migration (duplicates share the same timestamp).
// 2) Normalize owner to lowercase in usageHistory and apiKeys so budget/spend
//    queries can use `WHERE owner = ?` / `GROUP BY owner` (sargable, hits
//    idx_uh_owner) instead of lower(owner) which forces a full table scan.
//    Writes have always lowercased owner; this catches any pre-existing rows.
export default {
  version: 3,
  name: "usage_dedup_hash_and_owner_normalize",
  up(db) {
    const uhCols = db.all(`PRAGMA table_info(usageHistory)`);
    if (!uhCols.some((c) => c.name === "dedupHash")) {
      try {
        db.exec(`ALTER TABLE usageHistory ADD COLUMN dedupHash TEXT`);
      } catch (e) {
        if (!String(e?.message || "").includes("duplicate column")) throw e;
      }
    }
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_uh_dedup ON usageHistory(dedupHash)`);
    } catch {}

    if (uhCols.some((c) => c.name === "owner")) {
      db.exec(`UPDATE usageHistory SET owner = lower(trim(owner)) WHERE owner IS NOT NULL AND owner != lower(trim(owner))`);
      db.exec(`UPDATE usageHistory SET owner = NULL WHERE owner = ''`);
    }

    // apiKeys.owner may not exist yet on old upgrade paths (added by the
    // additive sync which runs after versioned migrations) — guard it.
    const akCols = db.all(`PRAGMA table_info(apiKeys)`);
    if (akCols.some((c) => c.name === "owner")) {
      db.exec(`UPDATE apiKeys SET owner = lower(trim(owner)) WHERE owner IS NOT NULL AND owner != lower(trim(owner))`);
      db.exec(`UPDATE apiKeys SET owner = NULL WHERE owner = ''`);
    }
  },
};
