-- Step 7 — creator monetization, international currencies and language preference
CREATE TYPE "AppLanguage" AS ENUM ('FR', 'EN');
CREATE TYPE "CreatorEarningSource" AS ENUM ('PAID_MESSAGE', 'PAID_CALL', 'VIDEO', 'SHORT', 'LIVE', 'CREATOR_SUBSCRIPTION', 'PAID_CONTENT', 'CUSTOM_VIDEO', 'GIFT', 'TIP', 'OTHER');
CREATE TYPE "CreatorEarningStatus" AS ENUM ('PENDING', 'AVAILABLE', 'REVERSED');

ALTER TABLE "User"
  ADD COLUMN "preferredLanguage" "AppLanguage" NOT NULL DEFAULT 'FR',
  ADD COLUMN "preferredCurrency" VARCHAR(3) NOT NULL DEFAULT 'XAF';

CREATE TABLE "ExchangeRate" (
  "id" TEXT NOT NULL,
  "baseCurrency" VARCHAR(3) NOT NULL,
  "quoteCurrency" VARCHAR(3) NOT NULL,
  "rate" DECIMAL(24,12) NOT NULL,
  "source" TEXT NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ExchangeRate_baseCurrency_quoteCurrency_fetchedAt_idx" ON "ExchangeRate"("baseCurrency","quoteCurrency","fetchedAt");

CREATE TABLE "CreatorEarning" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "source" "CreatorEarningSource" NOT NULL,
  "sourceId" TEXT NOT NULL,
  "grossAmount" INTEGER NOT NULL,
  "platformFeeAmount" INTEGER NOT NULL,
  "creatorAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "commissionBps" INTEGER NOT NULL,
  "status" "CreatorEarningStatus" NOT NULL DEFAULT 'PENDING',
  "ruleVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "availableAt" TIMESTAMP(3),
  "reversedAt" TIMESTAMP(3),
  CONSTRAINT "CreatorEarning_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorEarning_source_sourceId_key" ON "CreatorEarning"("source","sourceId");
CREATE INDEX "CreatorEarning_creatorId_status_createdAt_idx" ON "CreatorEarning"("creatorId","status","createdAt");
CREATE INDEX "CreatorEarning_creatorId_currency_createdAt_idx" ON "CreatorEarning"("creatorId","currency","createdAt");
ALTER TABLE "CreatorEarning" ADD CONSTRAINT "CreatorEarning_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
