-- Groupes à accès payant : prix d'entrée, propriétaire, achats d'accès.
ALTER TYPE "NotificationType" ADD VALUE 'GROUP_ACCESS_PURCHASED';
ALTER TYPE "CreatorEarningSource" ADD VALUE 'GROUP_ACCESS';

ALTER TABLE "Conversation" ADD COLUMN "entryPrice" INTEGER;
ALTER TABLE "Conversation" ADD COLUMN "entryCurrency" VARCHAR(3);
ALTER TABLE "Conversation" ADD COLUMN "ownerId" TEXT;
-- Propriétaire des groupes existants : le premier administrateur.
UPDATE "Conversation" AS c
SET "ownerId" = (SELECT m."userId" FROM "ConversationMember" AS m WHERE m."conversationId" = c."id" AND m."role" = 'ADMIN' ORDER BY m."id" LIMIT 1)
WHERE c."isGroup" = true;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "GroupAccessPurchase" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "grossAmount" INTEGER NOT NULL,
  "commissionAmount" INTEGER NOT NULL,
  "creatorAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF',
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
  "inviteId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "GroupAccessPurchase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GroupAccessPurchase_reference_key" ON "GroupAccessPurchase"("reference");
CREATE UNIQUE INDEX "GroupAccessPurchase_conversationId_buyerId_key" ON "GroupAccessPurchase"("conversationId", "buyerId");
CREATE INDEX "GroupAccessPurchase_sellerId_status_idx" ON "GroupAccessPurchase"("sellerId", "status");
CREATE INDEX "GroupAccessPurchase_status_initiatedAt_idx" ON "GroupAccessPurchase"("status", "initiatedAt");
ALTER TABLE "GroupAccessPurchase" ADD CONSTRAINT "GroupAccessPurchase_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupAccessPurchase" ADD CONSTRAINT "GroupAccessPurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GroupAccessPurchase" ADD CONSTRAINT "GroupAccessPurchase_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
