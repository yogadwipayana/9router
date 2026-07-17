// Tracks whether the Postgres ownerSpend aggregate is usable in this process.
// The table is created manually (broken migrate history — see
// prisma/manual/add-owner-spend.sql); until it exists and the Prisma client
// has been regenerated, readers/writers fall back to the SUM-over-usageHistory
// path. First failure disables further attempts to avoid per-request error spam.
let disabled = false;

export function ownerSpendPgAvailable(prisma) {
  return !disabled && typeof prisma?.ownerSpend?.findUnique === "function";
}

export function disableOwnerSpendPg(err) {
  if (disabled) return;
  disabled = true;
  console.warn(
    "[db] ownerSpend aggregate unavailable on Postgres — falling back to SUM(usageHistory). " +
    "Apply it with: npx prisma db execute --file prisma/manual/add-owner-spend.sql && npx prisma generate. " +
    `(${err?.code || err?.message || err})`
  );
}
