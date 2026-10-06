-- Étape 15 — Face to Face Premium
CREATE TYPE "PremiumBillingPeriod" AS ENUM ('MONTHLY', 'ANNUAL');
CREATE TYPE "PremiumSubscriptionStatus" AS ENUM ('PENDING_PAYMENT', 'ACTIVE', 'TRIAL', 'EXPIRED', 'CANCELLED');
CREATE TYPE "PremiumPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REVIEW');
CREATE TYPE "PremiumPromotionType" AS ENUM ('PERCENT', 'FIXED');

CREATE TABLE "PremiumSetting" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "monthlyPriceMinor" INTEGER NOT NULL DEFAULT 9500,
  "annualPriceMinor" INTEGER NOT NULL DEFAULT 114000,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF',
  "trialEnabled" BOOLEAN NOT NULL DEFAULT false,
  "trialDays" INTEGER NOT NULL DEFAULT 7,
  "autoRenewEnabled" BOOLEAN NOT NULL DEFAULT true,
  "benefits" JSONB NOT NULL,
  "updatedByUserId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PremiumSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PremiumPromotion" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" "PremiumPromotionType" NOT NULL,
  "value" INTEGER NOT NULL,
  "currency" VARCHAR(3),
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "maxRedemptions" INTEGER,
  "redemptionCount" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PremiumPromotion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PremiumPromotion_code_key" ON "PremiumPromotion"("code");
CREATE INDEX "PremiumPromotion_isActive_startsAt_endsAt_idx" ON "PremiumPromotion"("isActive", "startsAt", "endsAt");

CREATE TABLE "PremiumSubscription" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "PremiumSubscriptionStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "billingPeriod" "PremiumBillingPeriod" NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "priceAmount" INTEGER NOT NULL,
  "discountAmount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "trialEndsAt" TIMESTAMP(3),
  "autoRenew" BOOLEAN NOT NULL DEFAULT true,
  "cancelledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PremiumSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PremiumSubscription_userId_key" ON "PremiumSubscription"("userId");
CREATE INDEX "PremiumSubscription_status_expiresAt_idx" ON "PremiumSubscription"("status", "expiresAt");

CREATE TABLE "PremiumPayment" (
  "id" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "billingPeriod" "PremiumBillingPeriod" NOT NULL,
  "grossAmount" INTEGER NOT NULL,
  "discountAmount" INTEGER NOT NULL DEFAULT 0,
  "netAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL,
  "status" "PremiumPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT NOT NULL,
  "operator" TEXT,
  "payerPhoneHint" TEXT,
  "externalRef" TEXT,
  "providerPayload" JSONB,
  "reviewReason" TEXT,
  "promotionCode" TEXT,
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "PremiumPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PremiumPayment_reference_key" ON "PremiumPayment"("reference");
CREATE INDEX "PremiumPayment_userId_status_initiatedAt_idx" ON "PremiumPayment"("userId", "status", "initiatedAt");
CREATE INDEX "PremiumPayment_subscriptionId_createdAt_idx" ON "PremiumPayment"("subscriptionId", "initiatedAt");

ALTER TABLE "PremiumSubscription" ADD CONSTRAINT "PremiumSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PremiumPayment" ADD CONSTRAINT "PremiumPayment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PremiumSubscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PremiumPayment" ADD CONSTRAINT "PremiumPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
