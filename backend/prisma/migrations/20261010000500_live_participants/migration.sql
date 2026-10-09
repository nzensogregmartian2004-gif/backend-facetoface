-- Étape 9 : participants d'un Live (co-hosts). Présente dans schema.prisma, absente des migrations.
-- CreateEnum
CREATE TYPE "LiveParticipantRole" AS ENUM ('COHOST');

-- CreateTable
CREATE TABLE "LiveParticipant" (
    "id" TEXT NOT NULL,
    "liveId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "LiveParticipantRole" NOT NULL DEFAULT 'COHOST',
    "invitedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "mutedAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LiveParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LiveParticipant_liveId_userId_key" ON "LiveParticipant"("liveId", "userId");

-- CreateIndex
CREATE INDEX "LiveParticipant_liveId_removedAt_idx" ON "LiveParticipant"("liveId", "removedAt");

-- AddForeignKey
ALTER TABLE "LiveParticipant" ADD CONSTRAINT "LiveParticipant_liveId_fkey" FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiveParticipant" ADD CONSTRAINT "LiveParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
