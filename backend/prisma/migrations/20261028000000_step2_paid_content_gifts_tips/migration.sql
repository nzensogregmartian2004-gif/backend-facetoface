-- Étape 2 : contenu payant, gifts et tips.
-- Tous les montants sont des unités mineures de la devise indiquée.

ALTER TABLE "Video"
  ADD COLUMN "price" INTEGER,
  ADD COLUMN "currency" VARCHAR(3);

ALTER TABLE "Short"
  ADD COLUMN "price" INTEGER,
  ADD COLUMN "currency" VARCHAR(3);

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PAID_CONTENT_PURCHASED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GIFT_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TIP_RECEIVED';

CREATE TYPE "PaidContentKind" AS ENUM ('VIDEO', 'SHORT');

CREATE TABLE "PaidContentPurchase" (
  "id" TEXT NOT NULL,
  "contentType" "PaidContentKind" NOT NULL,
  "contentId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "grossAmount" INTEGER NOT NULL,
  "commissionAmount" INTEGER NOT NULL,
  "creatorAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "commissionBps" INTEGER NOT NULL,
  "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "method" TEXT,
  "operator" TEXT,
  "payerPhoneHint" TEXT,
  "externalRef" TEXT,
  "reviewReason" TEXT,
  "providerPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "PaidContentPurchase_pkey" PRIMARY KEY ("id")
);

-- Gift : table définie par 20261007230000_step8_coins (catalogue en points), ne pas recréer ici.

CREATE TABLE "GiftTransaction" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "giftId" TEXT NOT NULL,
  "liveId" TEXT,
  "grossAmount" INTEGER NOT NULL,
  "commissionAmount" INTEGER NOT NULL,
  "creatorAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "commissionBps" INTEGER NOT NULL,
  "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT,
  "operator" TEXT,
  "payerPhoneHint" TEXT,
  "externalRef" TEXT,
  "reviewReason" TEXT,
  "providerPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "GiftTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Tip" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "liveId" TEXT,
  "amount" INTEGER NOT NULL,
  "commissionAmount" INTEGER NOT NULL,
  "creatorAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "commissionBps" INTEGER NOT NULL,
  "message" TEXT,
  "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT,
  "operator" TEXT,
  "payerPhoneHint" TEXT,
  "externalRef" TEXT,
  "reviewReason" TEXT,
  "providerPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "Tip_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PaidContentPurchase_reference_key" ON "PaidContentPurchase"("reference");
CREATE UNIQUE INDEX "PaidContentPurchase_contentType_contentId_buyerId_key" ON "PaidContentPurchase"("contentType","contentId","buyerId");
CREATE INDEX "PaidContentPurchase_buyerId_status_idx" ON "PaidContentPurchase"("buyerId","status");
CREATE INDEX "PaidContentPurchase_creatorId_status_idx" ON "PaidContentPurchase"("creatorId","status");
CREATE INDEX "PaidContentPurchase_status_initiatedAt_idx" ON "PaidContentPurchase"("status","initiatedAt");
CREATE INDEX "PaidContentPurchase_contentType_contentId_idx" ON "PaidContentPurchase"("contentType","contentId");


CREATE UNIQUE INDEX "GiftTransaction_reference_key" ON "GiftTransaction"("reference");
CREATE INDEX "GiftTransaction_senderId_createdAt_idx" ON "GiftTransaction"("senderId","createdAt");
CREATE INDEX "GiftTransaction_creatorId_status_createdAt_idx" ON "GiftTransaction"("creatorId","status","createdAt");
CREATE INDEX "GiftTransaction_giftId_createdAt_idx" ON "GiftTransaction"("giftId","createdAt");
CREATE INDEX "GiftTransaction_liveId_createdAt_idx" ON "GiftTransaction"("liveId","createdAt");

CREATE INDEX "Tip_senderId_createdAt_idx" ON "Tip"("senderId","createdAt");
CREATE INDEX "Tip_creatorId_status_createdAt_idx" ON "Tip"("creatorId","status","createdAt");
CREATE INDEX "Tip_liveId_createdAt_idx" ON "Tip"("liveId","createdAt");
CREATE UNIQUE INDEX "Tip_reference_key" ON "Tip"("reference");

ALTER TABLE "PaidContentPurchase"
  ADD CONSTRAINT "PaidContentPurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PaidContentPurchase_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GiftTransaction"
  ADD CONSTRAINT "GiftTransaction_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GiftTransaction_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GiftTransaction_giftId_fkey" FOREIGN KEY ("giftId") REFERENCES "Gift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PaidContentPurchase"
  ADD CONSTRAINT "PaidContentPurchase_reference_check" CHECK ("reference" IS NULL OR length("reference") <= 13);

ALTER TABLE "GiftTransaction"
  ADD CONSTRAINT "GiftTransaction_reference_check" CHECK ("reference" IS NULL OR length("reference") <= 13);

ALTER TABLE "Tip"
  ADD CONSTRAINT "Tip_reference_check" CHECK ("reference" IS NULL OR length("reference") <= 13);

