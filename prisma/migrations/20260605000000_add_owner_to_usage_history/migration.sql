-- Add owner column to usageHistory so spend survives ApiKey deletion.
-- Previously spentUsd was computed by JOINing usageHistory to apiKeys on the
-- key string; deleting an ApiKey row dropped that user's history from the
-- aggregate and the "Used" total reset to $0.

ALTER TABLE "usageHistory" ADD COLUMN "owner" TEXT;

-- Backfill existing rows from the live apiKeys table while the link still exists.
UPDATE "usageHistory" h
SET "owner" = lower(k."owner")
FROM "apiKeys" k
WHERE h."apiKey" = k."key"
  AND k."owner" IS NOT NULL
  AND btrim(k."owner") != '';

CREATE INDEX IF NOT EXISTS "idx_uh_owner" ON "usageHistory" ("owner");
