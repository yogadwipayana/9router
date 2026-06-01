-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "apiKeys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT,
    "owner" TEXT,
    "machineId" TEXT,
    "isActive" INTEGER DEFAULT 1,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "apiKeys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ownerUsers" (
    "email" TEXT NOT NULL,
    "budgetUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" INTEGER DEFAULT 1,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "ownerUsers_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "usageHistory" (
    "id" SERIAL NOT NULL,
    "timestamp" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "connectionId" TEXT,
    "apiKey" TEXT,
    "endpoint" TEXT,
    "promptTokens" INTEGER DEFAULT 0,
    "completionTokens" INTEGER DEFAULT 0,
    "cost" DOUBLE PRECISION DEFAULT 0,
    "status" TEXT,
    "tokens" TEXT,
    "meta" TEXT,

    CONSTRAINT "usageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usageDaily" (
    "dateKey" TEXT NOT NULL,
    "data" TEXT NOT NULL,

    CONSTRAINT "usageDaily_pkey" PRIMARY KEY ("dateKey")
);

-- CreateTable
CREATE TABLE "requestDetails" (
    "id" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "connectionId" TEXT,
    "status" TEXT,
    "data" TEXT NOT NULL,

    CONSTRAINT "requestDetails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "apiKeys_key_key" ON "apiKeys"("key");

-- CreateIndex
CREATE INDEX "idx_ak_key" ON "apiKeys"("key");

-- CreateIndex
CREATE INDEX "idx_uh_ts" ON "usageHistory"("timestamp");

-- CreateIndex
CREATE INDEX "idx_uh_provider" ON "usageHistory"("provider");

-- CreateIndex
CREATE INDEX "idx_uh_model" ON "usageHistory"("model");

-- CreateIndex
CREATE INDEX "idx_uh_conn" ON "usageHistory"("connectionId");

-- CreateIndex
CREATE INDEX "idx_rd_ts" ON "requestDetails"("timestamp");

-- CreateIndex
CREATE INDEX "idx_rd_provider" ON "requestDetails"("provider");

-- CreateIndex
CREATE INDEX "idx_rd_model" ON "requestDetails"("model");

-- CreateIndex
CREATE INDEX "idx_rd_conn" ON "requestDetails"("connectionId");
