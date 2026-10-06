-- AlterTable
ALTER TABLE "AppConfig"
ALTER COLUMN "updatedAt" DROP DEFAULT;
-- AlterTable
ALTER TABLE "Live"
ALTER COLUMN "title"
SET DATA TYPE TEXT;
-- AlterTable
ALTER TABLE "MessagePurchase"
ADD COLUMN "externalRef" TEXT,
    ADD COLUMN "method" TEXT;
-- RenameIndex
ALTER INDEX "PremiumPayment_subscriptionId_createdAt_idx"
RENAME TO "PremiumPayment_subscriptionId_initiatedAt_idx";