-- Vouchers gain a `kind` so one table can back two products:
--   ai  → tops up ownerUsers.budgetUsd (USD), redeemed via /v1/admin/voucher
--   sms → tops up an external IDR wallet, claimed via /v1/admin/voucher/claim
--
-- `amountIdr` is only meaningful for kind='sms' (and `amountUsd` only for
-- kind='ai'); the unused one stays 0. Keeping both columns on one row avoids a
-- second table for what is otherwise an identical lifecycle (create → claim).
--
-- Applied manually because the Prisma migrate history is broken — run:
--   npx prisma db execute --file prisma/manual/add-voucher-kind.sql
--   npx prisma generate
-- Idempotent: safe to re-run; existing rows keep kind='ai'.

ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "amountIdr" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_voucher_kind" ON "vouchers" ("kind");
