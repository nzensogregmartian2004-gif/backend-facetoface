-- Step 11 — abonnements créateurs
ALTER TYPE "CallAccess" ADD VALUE IF NOT EXISTS 'SUBSCRIBERS';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CREATOR_SUBSCRIPTION_PURCHASED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CREATOR_SUBSCRIPTION_CANCELLED';

CREATE TYPE "LiveAccess" AS ENUM ('EVERYONE', 'SUBSCRIBERS');
ALTER TABLE "Live" ADD COLUMN "access" "LiveAccess" NOT NULL DEFAULT 'EVERYONE';

ALTER TABLE "Video" ADD COLUMN "subscriptionOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Short" ADD COLUMN "subscriptionOnly" BOOLEAN NOT NULL DEFAULT false;

CREATE TYPE "CreatorSubscriptionStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'CANCELLED', 'EXPIRED');
CREATE TYPE "CreatorSubscriptionPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REVIEW');

CREATE TABLE "CreatorSubscriptionPlan" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "benefits" JSONB NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSubscriptionPlan_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorSubscriptionPlan_creatorId_key" ON "CreatorSubscriptionPlan"("creatorId");
CREATE INDEX "CreatorSubscriptionPlan_isActive_creatorId_idx" ON "CreatorSubscriptionPlan"("isActive", "creatorId");
ALTER TABLE "CreatorSubscriptionPlan" ADD CONSTRAINT "CreatorSubscriptionPlan_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreatorSubscription" (
  "id" TEXT NOT NULL,
  "subscriberId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" "CreatorSubscriptionStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "currency" VARCHAR(3) NOT NULL,
  "priceMinor" INTEGER NOT NULL,
  "startedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "autoRenew" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorSubscription_subscriberId_creatorId_key" ON "CreatorSubscription"("subscriberId", "creatorId");
CREATE INDEX "CreatorSubscription_creatorId_status_expiresAt_idx" ON "CreatorSubscription"("creatorId", "status", "expiresAt");
CREATE INDEX "CreatorSubscription_subscriberId_status_expiresAt_idx" ON "CreatorSubscription"("subscriberId", "status", "expiresAt");
ALTER TABLE "CreatorSubscription" ADD CONSTRAINT "CreatorSubscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscription" ADD CONSTRAINT "CreatorSubscription_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscription" ADD CONSTRAINT "CreatorSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CreatorSubscriptionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CreatorSubscriptionPayment" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "grossFcfa" INTEGER NOT NULL,
  "commissionFcfa" INTEGER NOT NULL,
  "creatorFcfa" INTEGER NOT NULL,
  "commissionBps" INTEGER NOT NULL,
  "status" "CreatorSubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "operator" TEXT,
  "payerPhoneHint" TEXT,
  "externalRef" TEXT,
  "reviewReason" TEXT,
  "providerPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "CreatorSubscriptionPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorSubscriptionPayment_reference_key" ON "CreatorSubscriptionPayment"("reference");
CREATE INDEX "CreatorSubscriptionPayment_creatorId_status_idx" ON "CreatorSubscriptionPayment"("creatorId", "status");
CREATE INDEX "CreatorSubscriptionPayment_buyerId_status_idx" ON "CreatorSubscriptionPayment"("buyerId", "status");
CREATE INDEX "CreatorSubscriptionPayment_status_initiatedAt_idx" ON "CreatorSubscriptionPayment"("status", "initiatedAt");
ALTER TABLE "CreatorSubscriptionPayment" ADD CONSTRAINT "CreatorSubscriptionPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "CreatorSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscriptionPayment" ADD CONSTRAINT "CreatorSubscriptionPayment_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreatorSubscriptionPayment" ADD CONSTRAINT "CreatorSubscriptionPayment_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
