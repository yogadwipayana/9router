import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const APP_NAME = "9router";

function defaultDataDir() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function getDataFile() {
  const dataDir = process.env.DATA_DIR || defaultDataDir();
  return path.join(dataDir, "db", "data.sqlite");
}

function getRows(db, tableName) {
  try {
    return db.prepare(`SELECT * FROM ${tableName}`).all();
  } catch (error) {
    if (/no such table/i.test(error.message)) return [];
    throw error;
  }
}

function normalizeIntFlag(value) {
  return value === false || value === 0 ? 0 : 1;
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getKvRows(db, scope) {
  try {
    return db.prepare(`SELECT key, value FROM kv WHERE scope = ?`).all(scope);
  } catch (error) {
    if (/no such table/i.test(error.message)) return [];
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required. Set it in .env before running this script.");
  }

  const dataFile = getDataFile();
  if (!fs.existsSync(dataFile)) {
    throw new Error(`Local SQLite database not found: ${dataFile}`);
  }

  const sqlite = new Database(dataFile, { readonly: true });
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const counts = {
    apiKeys: 0,
    ownerUsers: 0,
    usageHistory: 0,
    usageDaily: 0,
    enabledModels: 0,
    enabledProviders: 0,
  };

  try {
    for (const row of getRows(sqlite, "apiKeys")) {
      await prisma.apiKey.upsert({
        where: { id: row.id },
        create: {
          id: row.id,
          key: row.key,
          name: row.name || null,
          owner: row.owner || null,
          machineId: row.machineId || null,
          isActive: normalizeIntFlag(row.isActive),
          createdAt: row.createdAt || new Date().toISOString(),
        },
        update: {
          key: row.key,
          name: row.name || null,
          owner: row.owner || null,
          machineId: row.machineId || null,
          isActive: normalizeIntFlag(row.isActive),
          createdAt: row.createdAt || new Date().toISOString(),
        },
      });
      counts.apiKeys++;
    }

    for (const row of getRows(sqlite, "ownerUsers")) {
      const now = new Date().toISOString();
      await prisma.ownerUser.upsert({
        where: { email: row.email },
        create: {
          email: row.email,
          budgetUsd: Number(row.budgetUsd || 0),
          isActive: normalizeIntFlag(row.isActive),
          createdAt: row.createdAt || now,
          updatedAt: row.updatedAt || now,
        },
        update: {
          budgetUsd: Number(row.budgetUsd || 0),
          isActive: normalizeIntFlag(row.isActive),
          updatedAt: row.updatedAt || now,
        },
      });
      counts.ownerUsers++;
    }

    for (const row of getRows(sqlite, "usageHistory")) {
      await prisma.usageHistory.upsert({
        where: { id: Number(row.id) },
        create: {
          id: Number(row.id),
          timestamp: row.timestamp,
          provider: row.provider || null,
          model: row.model || null,
          connectionId: row.connectionId || null,
          apiKey: row.apiKey || null,
          endpoint: row.endpoint || null,
          promptTokens: Number(row.promptTokens || 0),
          completionTokens: Number(row.completionTokens || 0),
          cost: Number(row.cost || 0),
          status: row.status || null,
          tokens: row.tokens || null,
          meta: row.meta || null,
        },
        update: {
          timestamp: row.timestamp,
          provider: row.provider || null,
          model: row.model || null,
          connectionId: row.connectionId || null,
          apiKey: row.apiKey || null,
          endpoint: row.endpoint || null,
          promptTokens: Number(row.promptTokens || 0),
          completionTokens: Number(row.completionTokens || 0),
          cost: Number(row.cost || 0),
          status: row.status || null,
          tokens: row.tokens || null,
          meta: row.meta || null,
        },
      });
      counts.usageHistory++;
    }

    for (const row of getRows(sqlite, "usageDaily")) {
      await prisma.usageDaily.upsert({
        where: { dateKey: row.dateKey },
        create: { dateKey: row.dateKey, data: row.data },
        update: { data: row.data },
      });
      counts.usageDaily++;
    }

    const now = new Date().toISOString();

    for (const row of getKvRows(sqlite, "enabledModels")) {
      const models = parseJson(row.value, []);
      if (!Array.isArray(models)) continue;

      const data = [...new Set(models)]
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
        .map((modelId) => ({
          providerAlias: row.key,
          modelId: modelId.trim(),
          createdAt: now,
        }));

      if (data.length === 0) continue;
      const result = await prisma.enabledModel.createMany({
        data,
        skipDuplicates: true,
      });
      counts.enabledModels += result.count;
    }

    const enabledProviders = getKvRows(sqlite, "enabledProviders")
      .filter((row) => parseJson(row.value, true) !== false)
      .map((row) => ({ providerAlias: row.key, createdAt: now }));
    if (enabledProviders.length > 0) {
      const result = await prisma.enabledProvider.createMany({
        data: enabledProviders,
        skipDuplicates: true,
      });
      counts.enabledProviders += result.count;
    }

    if (counts.usageHistory > 0) {
      await prisma.$executeRaw`SELECT setval(pg_get_serial_sequence('"usageHistory"', 'id'), COALESCE((SELECT MAX("id") FROM "usageHistory"), 1), true)`;
    }

    console.log("[prisma:migrate-data] copied selected local data to PostgreSQL:");
    for (const [tableName, count] of Object.entries(counts)) {
      console.log(`- ${tableName}: ${count}`);
    }
  } finally {
    sqlite.close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[prisma:migrate-data] failed:", error);
  process.exit(1);
});
