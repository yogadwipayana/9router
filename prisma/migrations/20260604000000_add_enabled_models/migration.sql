-- CreateTable
CREATE TABLE "enabledModels" (
    "providerAlias" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "enabledModels_pkey" PRIMARY KEY ("providerAlias", "modelId")
);

-- CreateTable
CREATE TABLE "enabledProviders" (
    "providerAlias" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,

    CONSTRAINT "enabledProviders_pkey" PRIMARY KEY ("providerAlias")
);

-- CreateIndex
CREATE INDEX "idx_em_provider" ON "enabledModels"("providerAlias");
