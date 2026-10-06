-- Étape 17 — Centre de configuration
CREATE TYPE "AppConfigType" AS ENUM ('STRING', 'INTEGER', 'DECIMAL', 'BOOLEAN', 'JSON');
CREATE TYPE "AppConfigCategory" AS ENUM ('PREMIUM', 'COMMISSION', 'CREATOR_POOL', 'MONETIZATION', 'SHORTS', 'VIDEOS', 'LIVES', 'WITHDRAWALS', 'FEATURE_PRICING', 'ADVERTISING', 'PROMOTIONS', 'GENERAL');

CREATE TABLE "AppConfig" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "type" "AppConfigType" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "description" TEXT NOT NULL,
  "defaultValue" JSONB NOT NULL,
  "category" "AppConfigCategory" NOT NULL DEFAULT 'GENERAL',
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedById" TEXT,
  CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AppConfig_key_key" ON "AppConfig"("key");
CREATE INDEX "AppConfig_category_enabled_idx" ON "AppConfig"("category", "enabled");
CREATE INDEX "AppConfig_updatedById_updatedAt_idx" ON "AppConfig"("updatedById", "updatedAt");

ALTER TABLE "AppConfig" ADD CONSTRAINT "AppConfig_updatedById_fkey"
  FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
