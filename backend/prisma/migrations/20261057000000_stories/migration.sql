-- Stories : photo ou vidéo visible pendant une durée choisie, puis supprimée. Vues par spectateur.
CREATE TABLE "Story" (
  "id" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "mediaKey" TEXT NOT NULL,
  "mediaType" TEXT NOT NULL,
  "mediaMime" TEXT NOT NULL,
  "mediaSize" INTEGER NOT NULL,
  "caption" VARCHAR(200),
  "hours" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Story_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Story_mediaKey_key" ON "Story"("mediaKey");
CREATE INDEX "Story_authorId_expiresAt_idx" ON "Story"("authorId", "expiresAt");
CREATE INDEX "Story_expiresAt_idx" ON "Story"("expiresAt");
ALTER TABLE "Story" ADD CONSTRAINT "Story_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StoryView" (
  "storyId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StoryView_pkey" PRIMARY KEY ("storyId", "viewerId")
);
CREATE INDEX "StoryView_viewerId_idx" ON "StoryView"("viewerId");
ALTER TABLE "StoryView" ADD CONSTRAINT "StoryView_storyId_fkey" FOREIGN KEY ("storyId") REFERENCES "Story"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoryView" ADD CONSTRAINT "StoryView_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
