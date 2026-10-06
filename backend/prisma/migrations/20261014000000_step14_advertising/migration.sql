-- Étape 14 : système publicitaire multi-format, campagnes, fréquence et revenus.
CREATE TYPE "AdFormat" AS ENUM ('PRE_ROLL', 'MID_ROLL', 'SHORT_BETWEEN', 'NATIVE', 'BANNER', 'INTERSTITIAL', 'LIVE');
CREATE TYPE "AdPlacement" AS ENUM ('HOME_FEED', 'VIDEO_PLAYER', 'SHORT_FEED', 'LIVE_PLAYER', 'SEARCH', 'PROFILE');
CREATE TYPE "AdCampaignStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED');

CREATE TABLE "AdvertisingSetting" (
  "id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "defaultFrequencyCap" INTEGER NOT NULL DEFAULT 3,
  "defaultFrequencyWindowHours" INTEGER NOT NULL DEFAULT 24,
  "creatorShareBps" INTEGER NOT NULL DEFAULT 4000,
  "updatedByUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdvertisingSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingCampaign" (
  "id" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "headline" TEXT NOT NULL,
  "body" TEXT,
  "mediaUrl" TEXT,
  "clickUrl" TEXT,
  "status" "AdCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" VARCHAR(3) NOT NULL,
  "budgetAmount" INTEGER NOT NULL,
  "spentAmount" INTEGER NOT NULL DEFAULT 0,
  "pricePerImpression" INTEGER NOT NULL,
  "formats" "AdFormat"[] NOT NULL,
  "placements" "AdPlacement"[] NOT NULL,
  "targetLanguages" "AppLanguage"[] NOT NULL,
  "targetCountries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "targetCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "frequencyCap" INTEGER,
  "frequencyWindowHours" INTEGER,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdvertisingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdImpression" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "userId" TEXT,
  "creatorId" TEXT,
  "format" "AdFormat" NOT NULL,
  "placement" "AdPlacement" NOT NULL,
  "contentType" TEXT,
  "contentId" TEXT,
  "category" TEXT,
  "eventKey" TEXT NOT NULL,
  "chargedAmount" INTEGER NOT NULL,
  "creatorPoolAmount" INTEGER NOT NULL,
  "platformAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "advertisingRevenueId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdImpression_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdClick" (
  "id" TEXT NOT NULL,
  "impressionId" TEXT NOT NULL,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AdClick_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdImpression_eventKey_key" ON "AdImpression"("eventKey");
CREATE UNIQUE INDEX "AdImpression_advertisingRevenueId_key" ON "AdImpression"("advertisingRevenueId");
CREATE UNIQUE INDEX "AdClick_impressionId_key" ON "AdClick"("impressionId");
CREATE INDEX "AdvertisingCampaign_status_startsAt_endsAt_idx" ON "AdvertisingCampaign"("status", "startsAt", "endsAt");
CREATE INDEX "AdvertisingCampaign_currency_status_idx" ON "AdvertisingCampaign"("currency", "status");
CREATE INDEX "AdImpression_campaignId_createdAt_idx" ON "AdImpression"("campaignId", "createdAt");
CREATE INDEX "AdImpression_userId_campaignId_createdAt_idx" ON "AdImpression"("userId", "campaignId", "createdAt");
CREATE INDEX "AdImpression_creatorId_createdAt_idx" ON "AdImpression"("creatorId", "createdAt");
CREATE INDEX "AdClick_userId_createdAt_idx" ON "AdClick"("userId", "createdAt");

ALTER TABLE "AdvertisingCampaign" ADD CONSTRAINT "AdvertisingCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdImpression" ADD CONSTRAINT "AdImpression_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdvertisingCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdImpression" ADD CONSTRAINT "AdImpression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdImpression" ADD CONSTRAINT "AdImpression_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdImpression" ADD CONSTRAINT "AdImpression_advertisingRevenueId_fkey" FOREIGN KEY ("advertisingRevenueId") REFERENCES "AdvertisingRevenue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdClick" ADD CONSTRAINT "AdClick_impressionId_fkey" FOREIGN KEY ("impressionId") REFERENCES "AdImpression"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdClick" ADD CONSTRAINT "AdClick_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
