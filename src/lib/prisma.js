import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis;

export function hasPrismaDatabaseUrl() {
  return typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim() !== "";
}

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required to initialize Prisma.");
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export function getPrisma() {
  if (!globalForPrisma.__prisma) {
    globalForPrisma.__prisma = createPrismaClient();
  }
  return globalForPrisma.__prisma;
}

export function usePostgresOperationalData() {
  return hasPrismaDatabaseUrl() && process.env.POSTGRES_OPERATIONAL_DATA !== "false";
}
