CREATE TYPE "MonetizationApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "CreatorMonetizationEligibility" (
  "id" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "status" "MonetizationApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "reviewedAt" TIMESTAMP(3),
  "reviewedByUserId" TEXT,
  "rejectionReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreatorMonetizationEligibility_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreatorMonetizationEligibility_creatorId_key" ON "CreatorMonetizationEligibility"("creatorId");
ALTER TABLE "CreatorMonetizationEligibility" ADD CONSTRAINT "CreatorMonetizationEligibility_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Video" ADD COLUMN "isOriginal" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Short" ADD COLUMN "isOriginal" BOOLEAN NOT NULL DEFAULT true;
