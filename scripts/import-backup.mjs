import { readFileSync } from "node:fs";
import pg from "pg";

const sqlPath = process.argv[2];
const connectionString = process.env.DATABASE_URL;

if (!sqlPath) {
  console.error("Usage: node scripts/import-backup.mjs <path-to-sql>");
  process.exit(1);
}
if (!connectionString) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

let sql = readFileSync(sqlPath, "utf8");
console.log(`Loaded ${sqlPath} (${sql.length} bytes)`);

// The backup references "usageHistory_id_seq" as a column default but never
// creates it, and its own `DROP TABLE ... CASCADE` removes the SERIAL-owned
// sequence. Recreate the sequence after the drop, then re-own and reset it.
const dropLine = 'DROP TABLE IF EXISTS "public"."usageHistory" CASCADE;';
sql = sql.replace(
  dropLine,
  `${dropLine}\nCREATE SEQUENCE IF NOT EXISTS "public"."usageHistory_id_seq";`
);
sql = sql.replace(
  /COMMIT;\s*$/,
  `ALTER SEQUENCE "public"."usageHistory_id_seq" OWNED BY "public"."usageHistory"."id";\n` +
    `SELECT setval('"public"."usageHistory_id_seq"', COALESCE((SELECT MAX("id") FROM "public"."usageHistory"), 1));\n` +
    `COMMIT;`
);

const client = new pg.Client({ connectionString });

const start = Date.now();
try {
  await client.connect();
  console.log("Connected. Executing backup as a single transaction...");
  await client.query(sql);
  console.log(`Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error("Import failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
