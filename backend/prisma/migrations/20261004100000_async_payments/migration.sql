-- Paiements asynchrones (MyPVit) : nouveau statut REVIEW, suivi des tentatives, clés étrangères en RESTRICT.

-- AlterEnum
ALTER TYPE "PurchaseStatus" ADD VALUE 'REVIEW';

-- AlterTable
ALTER TABLE "MessagePurchase"
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "operator" TEXT,
  ADD COLUMN "payerPhoneHint" TEXT,
  ADD COLUMN "reviewReason" TEXT,
  ADD COLUMN "providerPayload" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "MessagePurchase_reference_key" ON "MessagePurchase"("reference");

-- CreateIndex
CREATE INDEX "MessagePurchase_status_initiatedAt_idx" ON "MessagePurchase"("status", "initiatedAt");

-- Un achat est une écriture financière : jamais de suppression en cascade.
ALTER TABLE "MessagePurchase" DROP CONSTRAINT "MessagePurchase_messageId_fkey";
ALTER TABLE "MessagePurchase" DROP CONSTRAINT "MessagePurchase_buyerId_fkey";
ALTER TABLE "MessagePurchase" DROP CONSTRAINT "MessagePurchase_sellerId_fkey";
ALTER TABLE "MessagePurchase" ADD CONSTRAINT "MessagePurchase_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessagePurchase" ADD CONSTRAINT "MessagePurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MessagePurchase" ADD CONSTRAINT "MessagePurchase_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
