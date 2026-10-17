-- Lot 2 : temps de visionnage des vidéos longues (additif uniquement, miroir de ShortWatchEvent).

-- CreateTable
CREATE TABLE "VideoWatchEvent" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientSessionId" VARCHAR(64) NOT NULL,
    "watchedMs" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoWatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoWatchEvent_userId_clientSessionId_key" ON "VideoWatchEvent"("userId", "clientSessionId");

-- CreateIndex
CREATE INDEX "VideoWatchEvent_videoId_createdAt_idx" ON "VideoWatchEvent"("videoId", "createdAt");

-- AddForeignKey
ALTER TABLE "VideoWatchEvent" ADD CONSTRAINT "VideoWatchEvent_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoWatchEvent" ADD CONSTRAINT "VideoWatchEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
