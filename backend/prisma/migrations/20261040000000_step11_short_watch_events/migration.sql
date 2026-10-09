-- Étape 11 : temps de visionnage des Shorts (additif uniquement).

-- CreateTable
CREATE TABLE "ShortWatchEvent" (
    "id" TEXT NOT NULL,
    "shortId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientSessionId" VARCHAR(64) NOT NULL,
    "watchedMs" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShortWatchEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShortWatchEvent_userId_clientSessionId_key" ON "ShortWatchEvent"("userId", "clientSessionId");

-- CreateIndex
CREATE INDEX "ShortWatchEvent_shortId_createdAt_idx" ON "ShortWatchEvent"("shortId", "createdAt");

-- AddForeignKey
ALTER TABLE "ShortWatchEvent" ADD CONSTRAINT "ShortWatchEvent_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "Short"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShortWatchEvent" ADD CONSTRAINT "ShortWatchEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
