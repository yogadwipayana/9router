-- Recompute ownerSpend from usageHistory (overwrites existing counters).
-- Use after the aggregate has drifted — e.g. spend accrued while the server
-- was still on the SUM fallback (before restart picked up the new client).
--   npx prisma db execute --file prisma/manual/resync-owner-spend.sql
-- Run while traffic is idle: an increment committed mid-statement could be
-- overwritten by the recomputed value.
-- ⚠ Do NOT use once usageRetentionDays pruning is enabled — history older than
-- the retention window is gone, so recomputing would erase that spend.

INSERT INTO "ownerSpend" ("owner", "spentUsd", "requestCount", "updatedAt")
SELECT "owner",
       COALESCE(SUM("cost"), 0),
       COUNT("id")::int,
       to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "usageHistory"
WHERE "owner" IS NOT NULL AND "owner" != ''
GROUP BY "owner"
ON CONFLICT ("owner") DO UPDATE SET
  "spentUsd"     = EXCLUDED."spentUsd",
  "requestCount" = EXCLUDED."requestCount",
  "updatedAt"    = EXCLUDED."updatedAt";
