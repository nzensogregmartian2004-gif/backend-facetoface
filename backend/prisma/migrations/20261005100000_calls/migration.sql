-- Étape 6 : appels audio/vidéo payants (réglages créateur + appels). Écrite à la main : à comparer au schéma par `prisma migrate dev` (voir TODO.md).

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');
CREATE TYPE "CallPricingMode" AS ENUM ('PER_MINUTE', 'PER_SESSION');
CREATE TYPE "CallAccess" AS ENUM ('EVERYONE', 'FOLLOWERS');
CREATE TYPE "CallStatus" AS ENUM ('AWAITING_PAYMENT', 'PAYMENT_FAILED', 'RINGING', 'ACTIVE', 'ENDED', 'DECLINED', 'MISSED', 'CANCELLED');
CREATE TYPE "CallEndReason" AS ENUM ('HANGUP', 'MAX_DURATION', 'RING_TIMEOUT', 'DECLINED', 'CANCELLED', 'CREATOR_BUSY', 'STALE_PAYMENT');
CREATE TYPE "RefundStatus" AS ENUM ('NONE', 'DUE', 'REFUNDED');

-- CreateTable
CREATE TABLE "CreatorCallSettings" (
    "userId" TEXT NOT NULL,
    "pricingMode" "CallPricingMode" NOT NULL DEFAULT 'PER_MINUTE',
    "audioPriceFcfa" INTEGER,
    "videoPriceFcfa" INTEGER,
    "maxDurationMinutes" INTEGER NOT NULL DEFAULT 30,
    "access" "CallAccess" NOT NULL DEFAULT 'EVERYONE',
    "isAvailable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCallSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "callerId" TEXT NOT NULL,
    "calleeId" TEXT NOT NULL,
    "type" "CallType" NOT NULL,
    "pricingMode" "CallPricingMode" NOT NULL,
    "unitPriceFcfa" INTEGER NOT NULL,
    "requestedMinutes" INTEGER NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "endReason" "CallEndReason",
    "grossFcfa" INTEGER NOT NULL,
    "commissionBps" INTEGER NOT NULL,
    "paymentStatus" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "operator" TEXT,
    "payerPhoneHint" TEXT,
    "externalRef" TEXT,
    "reviewReason" TEXT,
    "providerPayload" JSONB,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "ringExpiresAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "actualSeconds" INTEGER,
    "consumedFcfa" INTEGER,
    "commissionFcfa" INTEGER,
    "creatorFcfa" INTEGER,
    "refundFcfa" INTEGER NOT NULL DEFAULT 0,
    "refundStatus" "RefundStatus" NOT NULL DEFAULT 'NONE',
    "disputedAt" TIMESTAMP(3),
    "disputeReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_reference_key" ON "Call"("reference");
CREATE INDEX "Call_callerId_createdAt_idx" ON "Call"("callerId", "createdAt");
CREATE INDEX "Call_calleeId_createdAt_idx" ON "Call"("calleeId", "createdAt");
CREATE INDEX "Call_calleeId_status_idx" ON "Call"("calleeId", "status");
CREATE INDEX "Call_callerId_status_idx" ON "Call"("callerId", "status");
CREATE INDEX "Call_status_ringExpiresAt_idx" ON "Call"("status", "ringExpiresAt");
CREATE INDEX "Call_status_endsAt_idx" ON "Call"("status", "endsAt");
CREATE INDEX "Call_paymentStatus_initiatedAt_idx" ON "Call"("paymentStatus", "initiatedAt");

-- AddForeignKey
ALTER TABLE "CreatorCallSettings" ADD CONSTRAINT "CreatorCallSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Un appel est une écriture financière : jamais de suppression en cascade.
ALTER TABLE "Call" ADD CONSTRAINT "Call_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Call" ADD CONSTRAINT "Call_calleeId_fkey" FOREIGN KEY ("calleeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
