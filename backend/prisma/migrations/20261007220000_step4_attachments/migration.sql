CREATE TYPE "AttachmentKind" AS ENUM ('PHOTO', 'VIDEO', 'AUDIO', 'PDF', 'DOCUMENT', 'ZIP', 'VOICE');
CREATE TYPE "AttachmentPurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REVIEW');
ALTER TYPE "CreatorEarningSource" ADD VALUE IF NOT EXISTS 'ATTACHMENT';


CREATE TABLE "Attachment" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "kind" "AttachmentKind" NOT NULL,
  "storageKey" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "durationMs" INTEGER,
  "price" INTEGER,
  "currency" VARCHAR(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");
CREATE INDEX "Attachment_kind_createdAt_idx" ON "Attachment"("kind", "createdAt");
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AttachmentPurchase" (
  "id" TEXT NOT NULL,
  "attachmentId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "grossAmount" INTEGER NOT NULL,
  "commissionAmount" INTEGER NOT NULL,
  "creatorAmount" INTEGER NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'XAF',
  "commissionBps" INTEGER NOT NULL,
  "status" "AttachmentPurchaseStatus" NOT NULL DEFAULT 'PENDING',
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
  CONSTRAINT "AttachmentPurchase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AttachmentPurchase_reference_key" ON "AttachmentPurchase"("reference");
CREATE UNIQUE INDEX "AttachmentPurchase_attachmentId_buyerId_key" ON "AttachmentPurchase"("attachmentId", "buyerId");
CREATE INDEX "AttachmentPurchase_buyerId_status_idx" ON "AttachmentPurchase"("buyerId", "status");
CREATE INDEX "AttachmentPurchase_sellerId_status_idx" ON "AttachmentPurchase"("sellerId", "status");
CREATE INDEX "AttachmentPurchase_status_initiatedAt_idx" ON "AttachmentPurchase"("status", "initiatedAt");
ALTER TABLE "AttachmentPurchase" ADD CONSTRAINT "AttachmentPurchase_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttachmentPurchase" ADD CONSTRAINT "AttachmentPurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttachmentPurchase" ADD CONSTRAINT "AttachmentPurchase_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
