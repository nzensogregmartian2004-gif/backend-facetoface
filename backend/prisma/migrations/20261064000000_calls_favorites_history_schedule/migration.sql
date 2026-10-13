-- Appels : masquage du journal par membre, favoris d'appel, appels planifiés.
ALTER TABLE "Call" ADD COLUMN "callerHiddenAt" TIMESTAMP(3), ADD COLUMN "calleeHiddenAt" TIMESTAMP(3);

CREATE TABLE "CallFavorite" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallFavorite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CallFavorite_ownerId_userId_key" ON "CallFavorite"("ownerId", "userId");
ALTER TABLE "CallFavorite" ADD CONSTRAINT "CallFavorite_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallFavorite" ADD CONSTRAINT "CallFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "ScheduledCallStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');
CREATE TABLE "ScheduledCall" (
  "id" TEXT NOT NULL,
  "callerId" TEXT NOT NULL,
  "creatorId" TEXT NOT NULL,
  "type" "CallType" NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "status" "ScheduledCallStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduledCall_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ScheduledCall_creatorId_status_startsAt_idx" ON "ScheduledCall"("creatorId", "status", "startsAt");
CREATE INDEX "ScheduledCall_callerId_startsAt_idx" ON "ScheduledCall"("callerId", "startsAt");
ALTER TABLE "ScheduledCall" ADD CONSTRAINT "ScheduledCall_callerId_fkey" FOREIGN KEY ("callerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduledCall" ADD CONSTRAINT "ScheduledCall_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
