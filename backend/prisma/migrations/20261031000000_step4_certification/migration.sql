-- Étape 4 : certification officielle des comptes. Additif : nouvelles colonnes nullables ou par défaut, nouvelle table.
CREATE TYPE "CertificationStatus" AS ENUM ('NON_CERTIFIED', 'PENDING', 'CERTIFIED', 'REVOKED');
ALTER TABLE "User" ADD COLUMN "certificationStatus" "CertificationStatus" NOT NULL DEFAULT 'NON_CERTIFIED',
  ADD COLUMN "certifiedAt" TIMESTAMP(3),
  ADD COLUMN "certifiedById" TEXT;
CREATE INDEX "User_certificationStatus_idx" ON "User"("certificationStatus");
ALTER TABLE "User" ADD CONSTRAINT "User_certifiedById_fkey" FOREIGN KEY ("certifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "CertificationEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CertificationEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CertificationEvent_userId_createdAt_idx" ON "CertificationEvent"("userId", "createdAt");
ALTER TABLE "CertificationEvent" ADD CONSTRAINT "CertificationEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CertificationEvent" ADD CONSTRAINT "CertificationEvent_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
