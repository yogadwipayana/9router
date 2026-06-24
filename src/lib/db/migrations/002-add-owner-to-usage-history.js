// Backfill owner column on usageHistory from the live apiKeys table.
// The new column itself is added via syncSchemaFromTables() (auto additive
// sync), but that step runs after versioned migrations and never backfills,
// so we mirror it here defensively and then copy the owner string in via
// the apiKey ↔ key match while it's still resolvable.
export default {
  version: 2,
  name: "add_owner_to_usage_history",
  up(db) {
    const cols = db.all(`PRAGMA table_info(usageHistory)`);
    const hasOwner = cols.some((c) => c.name === "owner");
    if (!hasOwner) {
      try {
        db.exec(`ALTER TABLE usageHistory ADD COLUMN owner TEXT`);
      } catch (e) {
        if (!String(e?.message || "").includes("duplicate column")) throw e;
      }
    }

    // The backfill reads apiKeys.owner, but on an upgrade path that column is
    // only added later by syncSchemaFromTables (which runs after versioned
    // migrations). Skip the backfill if it isn't there yet — the additive sync
    // will create it, and new rows already resolve owner at write time.
    const apiKeyCols = db.all(`PRAGMA table_info(apiKeys)`);
    const apiKeysHasOwner = apiKeyCols.some((c) => c.name === "owner");

    if (apiKeysHasOwner) {
      db.exec(`
        UPDATE usageHistory
        SET owner = (
          SELECT lower(k.owner)
          FROM apiKeys k
          WHERE k.key = usageHistory.apiKey
            AND k.owner IS NOT NULL
            AND trim(k.owner) != ''
        )
        WHERE owner IS NULL AND apiKey IS NOT NULL
      `);
    }

    try {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_uh_owner ON usageHistory(owner)`);
    } catch {}
  },
};
