-- tempApiKeys / tempUsageHistory: standalone, time- and cost-limited API keys.
-- Applied manually because the Prisma migrate history is broken — run:
--   npx prisma db execute --file prisma/manual/add-temp-api-keys.sql
--   npx prisma generate
-- (schema/datasource are picked up from prisma.config.mjs)
-- Idempotent: safe to re-run; existing rows are never clobbered.

CREATE TABLE IF NOT EXISTS "tempApiKeys" (
  "id"              TEXT PRIMARY KEY,
  "key"             TEXT NOT NULL,
  "name"            TEXT,
  "budgetUsd"       DOUBLE PRECISION NOT NULL,
  "spentUsd"        DOUBLE PRECISION NOT NULL DEFAULT 0,
  "requestCount"    INTEGER NOT NULL DEFAULT 0,
  "durationSeconds" INTEGER NOT NULL,
  "firstUsedAt"     TEXT,
  "expiresAt"       TEXT,
  "isActive"        INTEGER DEFAULT 1,
  "note"            TEXT,
  "createdAt"       TEXT NOT NULL,
  "updatedAt"       TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tempApiKeys_key_key" ON "tempApiKeys" ("key");
CREATE INDEX IF NOT EXISTS "idx_tak_key" ON "tempApiKeys" ("key");

CREATE TABLE IF NOT EXISTS "tempUsageHistory" (
  "id"               SERIAL PRIMARY KEY,
  "tempKeyId"        TEXT NOT NULL,
  "timestamp"        TEXT NOT NULL,
  "provider"         TEXT,
  "model"            TEXT,
  "endpoint"         TEXT,
  "promptTokens"     INTEGER DEFAULT 0,
  "completionTokens" INTEGER DEFAULT 0,
  "cost"             DOUBLE PRECISION DEFAULT 0,
  "status"           TEXT,
  "tokens"           TEXT
);

CREATE INDEX IF NOT EXISTS "idx_tuh_key" ON "tempUsageHistory" ("tempKeyId");
CREATE INDEX IF NOT EXISTS "idx_tuh_ts" ON "tempUsageHistory" ("timestamp");
