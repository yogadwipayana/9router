-- CreateTable
CREATE TABLE "pricing" (
    "providerAlias" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "input" DOUBLE PRECISION,
    "output" DOUBLE PRECISION,
    "cached" DOUBLE PRECISION,
    "reasoning" DOUBLE PRECISION,
    "cache_creation" DOUBLE PRECISION,
    "updatedAt" TEXT NOT NULL,

    CONSTRAINT "pricing_pkey" PRIMARY KEY ("providerAlias", "modelId")
);

-- CreateIndex
CREATE INDEX "idx_pricing_provider" ON "pricing"("providerAlias");
