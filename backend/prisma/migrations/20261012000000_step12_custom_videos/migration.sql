-- Étape 12 : vidéos personnalisées
CREATE TYPE "CustomVideoStatus" AS ENUM ('REQUESTED','AWAITING_PAYMENT','PAYMENT_PENDING','PAYMENT_REVIEW','AWAITING_CREATOR','ACCEPTED','IN_PROGRESS','DELIVERED','COMPLETED','DECLINED','CANCELLED','REFUND_DUE','DISPUTED','EXPIRED');
CREATE TYPE "CustomVideoPaymentStatus" AS ENUM ('PENDING','PAID','FAILED','REVIEW');

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_VIDEO_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_VIDEO_PAYMENT_CONFIRMED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_VIDEO_DELIVERED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_VIDEO_COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CUSTOM_VIDEO_DECLINED';

CREATE TABLE "CustomVideoRequest" (
  "id" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "requestText" TEXT NOT NULL,
  "priceFcfa" INTEGER,
  "currency" VARCHAR(3) NOT NULL,
  "deadlineAt" TIMESTAMP(3),
  "status" "CustomVideoStatus" NOT NULL DEFAULT 'REQUESTED',
  "acceptedAt" TIMESTAMP(3),
  "declinedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "disputedAt" TIMESTAMP(3),
  "disputeReason" TEXT,
  "refundDueAt" TIMESTAMP(3),
  "videoKey" TEXT,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "durationSeconds" INTEGER,
  "uploadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CustomVideoRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomVideoPayment" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "grossFcfa" INTEGER NOT NULL,
  "commissionFcfa" INTEGER NOT NULL,
  "creatorFcfa" INTEGER NOT NULL,
  "commissionBps" INTEGER NOT NULL,
  "status" "CustomVideoPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT,
  "operator" TEXT,
  "payerPhoneHint" TEXT,
  "externalRef" TEXT,
  "reviewReason" TEXT,
  "providerPayload" JSONB,
  "initiatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "CustomVideoPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CustomVideoPayment_reference_key" ON "CustomVideoPayment"("reference");
CREATE INDEX "CustomVideoRequest_buyerId_status_createdAt_idx" ON "CustomVideoRequest"("buyerId","status","createdAt");
CREATE INDEX "CustomVideoRequest_creatorId_status_createdAt_idx" ON "CustomVideoRequest"("creatorId","status","createdAt");
CREATE INDEX "CustomVideoRequest_status_deadlineAt_idx" ON "CustomVideoRequest"("status","deadlineAt");
CREATE INDEX "CustomVideoPayment_buyerId_status_idx" ON "CustomVideoPayment"("buyerId","status");
CREATE INDEX "CustomVideoPayment_creatorId_status_idx" ON "CustomVideoPayment"("creatorId","status");
CREATE INDEX "CustomVideoPayment_status_initiatedAt_idx" ON "CustomVideoPayment"("status","initiatedAt");

ALTER TABLE "CustomVideoRequest" ADD CONSTRAINT "CustomVideoRequest_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomVideoRequest" ADD CONSTRAINT "CustomVideoRequest_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomVideoPayment" ADD CONSTRAINT "CustomVideoPayment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CustomVideoRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomVideoPayment" ADD CONSTRAINT "CustomVideoPayment_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomVideoPayment" ADD CONSTRAINT "CustomVideoPayment_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
