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

const sql = readFileSync(sqlPath, "utf8");
console.log(`Loaded ${sqlPath} (${sql.length} bytes)`);

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
