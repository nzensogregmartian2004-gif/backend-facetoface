-- Étape 10 : Lives
CREATE TYPE "LiveStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED');
CREATE TYPE "LiveVisibility" AS ENUM ('PUBLIC', 'UNLISTED');
CREATE TYPE "LiveReactionType" AS ENUM ('LIKE', 'LOVE', 'FIRE', 'WOW');

CREATE TABLE "Live" (
  "id" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "description" TEXT,
  "thumbnailKey" TEXT,
  "visibility" "LiveVisibility" NOT NULL DEFAULT 'PUBLIC',
  "status" "LiveStatus" NOT NULL DEFAULT 'SCHEDULED',
  "scheduledAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "streamKey" TEXT NOT NULL,
  "currentViewers" INTEGER NOT NULL DEFAULT 0,
  "peakViewers" INTEGER NOT NULL DEFAULT 0,
  "uniqueViewers" INTEGER NOT NULL DEFAULT 0,
  "totalWatchSeconds" BIGINT NOT NULL DEFAULT 0,
  "totalMessages" INTEGER NOT NULL DEFAULT 0,
  "totalReactions" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Live_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveViewer" (
  "id" TEXT NOT NULL,
  "liveId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMP(3),
  "watchSeconds" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LiveViewer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveChatMessage" (
  "id" TEXT NOT NULL,
  "liveId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),

  CONSTRAINT "LiveChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LiveReaction" (
  "id" TEXT NOT NULL,
  "liveId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "LiveReactionType" NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LiveReaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Live_streamKey_key" ON "Live"("streamKey");
CREATE INDEX "Live_hostId_status_scheduledAt_idx" ON "Live"("hostId", "status", "scheduledAt");
CREATE INDEX "Live_status_scheduledAt_idx" ON "Live"("status", "scheduledAt");
CREATE UNIQUE INDEX "LiveViewer_liveId_userId_key" ON "LiveViewer"("liveId", "userId");
CREATE INDEX "LiveViewer_liveId_isActive_idx" ON "LiveViewer"("liveId", "isActive");
CREATE INDEX "LiveViewer_userId_createdAt_idx" ON "LiveViewer"("userId", "createdAt");
CREATE INDEX "LiveChatMessage_liveId_createdAt_idx" ON "LiveChatMessage"("liveId", "createdAt");
CREATE UNIQUE INDEX "LiveReaction_liveId_userId_type_key" ON "LiveReaction"("liveId", "userId", "type");
CREATE INDEX "LiveReaction_liveId_type_idx" ON "LiveReaction"("liveId", "type");

ALTER TABLE "Live" ADD CONSTRAINT "Live_hostId_fkey"
  FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveViewer" ADD CONSTRAINT "LiveViewer_liveId_fkey"
  FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveViewer" ADD CONSTRAINT "LiveViewer_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveChatMessage" ADD CONSTRAINT "LiveChatMessage_liveId_fkey"
  FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveChatMessage" ADD CONSTRAINT "LiveChatMessage_authorId_fkey"
  FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveReaction" ADD CONSTRAINT "LiveReaction_liveId_fkey"
  FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveReaction" ADD CONSTRAINT "LiveReaction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
