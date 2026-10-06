-- Step 8 — monétisation par les vues : revenus publicitaires réels -> Creator Pool -> allocation par vues qualifiées
ALTER TYPE "CreatorEarningSource" ADD VALUE IF NOT EXISTS 'CREATOR_POOL';

CREATE TYPE "AdvertisingRevenueStatus" AS ENUM ('RECEIVED', 'ALLOCATED', 'REVERSED');
CREATE TYPE "CreatorPoolStatus" AS ENUM ('OPEN', 'ALLOCATED', 'CLOSED');
CREATE TYPE "ViewAllocationStatus" AS ENUM ('ALLOCATED', 'REVERSED');

CREATE TABLE "ViewMonetizationSetting" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" INTEGER NOT NULL,
  "description" TEXT NOT NULL,
  "updatedByUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ViewMonetizationSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ViewMonetizationSetting_key_key" ON "ViewMonetizationSetting"("key");

CREATE TABLE "CreatorPool" (
  "id" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "grossAdRevenue" INTEGER NOT NULL,
  "creatorPoolAmount" INTEGER NOT NULL,
  "qualifiedViews" BIGINT NOT NULL DEFAULT 0,
  "allocatedAmount" INTEGER NOT NULL DEFAULT 0,
  "status" "CreatorPoolStatus" NOT NULL DEFAULT 'OPEN',
  "ruleVersion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "allocatedAt" TIMESTAMP(3),
  CONSTRAINT "CreatorPool_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorPool_periodStart_periodEnd_currency_key" ON "CreatorPool"("periodStart","periodEnd","currency");
CREATE INDEX "CreatorPool_currency_periodStart_periodEnd_idx" ON "CreatorPool"("currency","periodStart","periodEnd");
CREATE INDEX "CreatorPool_status_currency_idx" ON "CreatorPool"("status","currency");

CREATE TABLE "AdvertisingRevenue" (
  "id" TEXT NOT NULL,
  "externalReference" TEXT,
  "currency" VARCHAR(3) NOT NULL,
  "grossAmount" INTEGER NOT NULL,
  "platformShareBps" INTEGER NOT NULL,
  "creatorPoolShareBps" INTEGER NOT NULL,
  "creatorPoolAmount" INTEGER NOT NULL,
  "status" "AdvertisingRevenueStatus" NOT NULL DEFAULT 'RECEIVED',
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "creatorPoolId" TEXT,
  CONSTRAINT "AdvertisingRevenue_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdvertisingRevenue_externalReference_key" ON "AdvertisingRevenue"("externalReference");
CREATE INDEX "AdvertisingRevenue_currency_receivedAt_idx" ON "AdvertisingRevenue"("currency","receivedAt");
CREATE INDEX "AdvertisingRevenue_status_receivedAt_idx" ON "AdvertisingRevenue"("status","receivedAt");
CREATE INDEX "AdvertisingRevenue_creatorPoolId_idx" ON "AdvertisingRevenue"("creatorPoolId");

CREATE TABLE "CreatorViewAllocation" (
  "id" TEXT NOT NULL,
  "poolId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "qualifiedViews" BIGINT NOT NULL,
  "totalQualifiedViews" BIGINT NOT NULL,
  "shareBps" INTEGER NOT NULL,
  "grossAmount" INTEGER NOT NULL,
  "status" "ViewAllocationStatus" NOT NULL DEFAULT 'ALLOCATED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreatorViewAllocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorViewAllocation_poolId_creatorId_key" ON "CreatorViewAllocation"("poolId","creatorId");
CREATE INDEX "CreatorViewAllocation_creatorId_currency_createdAt_idx" ON "CreatorViewAllocation"("creatorId","currency","createdAt");
CREATE INDEX "CreatorViewAllocation_poolId_status_idx" ON "CreatorViewAllocation"("poolId","status");

ALTER TABLE "AdvertisingRevenue" ADD CONSTRAINT "AdvertisingRevenue_creatorPoolId_fkey"
  FOREIGN KEY ("creatorPoolId") REFERENCES "CreatorPool"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CreatorViewAllocation" ADD CONSTRAINT "CreatorViewAllocation_poolId_fkey"
  FOREIGN KEY ("poolId") REFERENCES "CreatorPool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorViewAllocation" ADD CONSTRAINT "CreatorViewAllocation_creatorId_fkey"
  FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "ViewMonetizationSetting" ("id","key","value","description","updatedAt")
VALUES ('step8_creator_pool_share','CREATOR_POOL_SHARE_BPS',4000,'Part des revenus publicitaires réellement encaissés versée au Creator Pool.',CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
