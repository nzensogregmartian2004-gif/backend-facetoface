-- CreateEnum
CREATE TYPE "CallMinuteEntryType" AS ENUM ('PURCHASE', 'INCLUDED_GRANT', 'CALL_DEBIT', 'CALL_CREDIT');

-- CreateEnum
CREATE TYPE "CallMinutePurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REVIEW');

-- CreateTable
CREATE TABLE "CallMinuteOffer" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" "CallType" NOT NULL,
    "seconds" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallMinuteOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallMinuteAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" "CallType" NOT NULL,
    "balanceSeconds" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallMinuteAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallMinutePurchase" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" "CallType" NOT NULL,
    "offerId" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "grossAmount" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "CallMinutePurchaseStatus" NOT NULL DEFAULT 'PENDING',
    "operator" TEXT,
    "payerPhoneHint" TEXT,
    "externalRef" TEXT,
    "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "reviewReason" TEXT,
    "providerPayload" JSONB,

    CONSTRAINT "CallMinutePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallMinuteEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "CallMinuteEntryType" NOT NULL,
    "seconds" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallMinuteEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallMinuteOffer_creatorId_kind_seconds_key" ON "CallMinuteOffer"("creatorId", "kind", "seconds");

-- CreateIndex
CREATE INDEX "CallMinuteOffer_creatorId_kind_active_idx" ON "CallMinuteOffer"("creatorId", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "CallMinuteAccount_userId_creatorId_kind_key" ON "CallMinuteAccount"("userId", "creatorId", "kind");

-- CreateIndex
CREATE INDEX "CallMinuteAccount_creatorId_kind_idx" ON "CallMinuteAccount"("creatorId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CallMinutePurchase_reference_key" ON "CallMinutePurchase"("reference");

-- CreateIndex
CREATE INDEX "CallMinutePurchase_userId_creatorId_status_initiatedAt_idx" ON "CallMinutePurchase"("userId", "creatorId", "status", "initiatedAt");

-- CreateIndex
CREATE INDEX "CallMinutePurchase_status_initiatedAt_idx" ON "CallMinutePurchase"("status", "initiatedAt");

-- CreateIndex
CREATE INDEX "CallMinuteEntry_accountId_createdAt_idx" ON "CallMinuteEntry"("accountId", "createdAt");

-- AddForeignKey
ALTER TABLE "CallMinuteOffer" ADD CONSTRAINT "CallMinuteOffer_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallMinuteAccount" ADD CONSTRAINT "CallMinuteAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallMinuteAccount" ADD CONSTRAINT "CallMinuteAccount_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallMinutePurchase" ADD CONSTRAINT "CallMinutePurchase_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallMinutePurchase" ADD CONSTRAINT "CallMinutePurchase_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallMinutePurchase" ADD CONSTRAINT "CallMinutePurchase_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "CallMinuteOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallMinuteEntry" ADD CONSTRAINT "CallMinuteEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CallMinuteAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
