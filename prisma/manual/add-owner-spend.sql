-- ownerSpend: incrementally-maintained lifetime spend per owner.
-- Applied manually because the Prisma migrate history is broken — run:
--   npx prisma db execute --file prisma/manual/add-owner-spend.sql
--   npx prisma generate
-- (schema/datasource are picked up from prisma.config.mjs)
-- Idempotent: safe to re-run; existing counters are never clobbered.

CREATE TABLE IF NOT EXISTS "ownerSpend" (
  "owner"        TEXT PRIMARY KEY,
  "spentUsd"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  "requestCount" INTEGER NOT NULL DEFAULT 0,
  "updatedAt"    TEXT NOT NULL
);

-- Seed from existing history (owner is already lowercase — writes normalize it
-- and the 20260605 migration backfilled with lower()).
INSERT INTO "ownerSpend" ("owner", "spentUsd", "requestCount", "updatedAt")
SELECT "owner",
       COALESCE(SUM("cost"), 0),
       COUNT("id")::int,
       to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
FROM "usageHistory"
WHERE "owner" IS NOT NULL AND "owner" != ''
GROUP BY "owner"
ON CONFLICT ("owner") DO NOTHING;
