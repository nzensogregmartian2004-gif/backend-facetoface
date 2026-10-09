-- Étape 12 : hashtags et mentions (additif uniquement).

-- CreateTable
CREATE TABLE "Hashtag" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hashtag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentHashtag" (
    "id" TEXT NOT NULL,
    "hashtagId" TEXT NOT NULL,
    "contentType" "ContentTargetType" NOT NULL,
    "contentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentHashtag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mention" (
    "id" TEXT NOT NULL,
    "contentType" "ContentTargetType" NOT NULL,
    "contentId" TEXT NOT NULL,
    "mentionedUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mention_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Hashtag_name_key" ON "Hashtag"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ContentHashtag_hashtagId_contentType_contentId_key" ON "ContentHashtag"("hashtagId", "contentType", "contentId");

-- CreateIndex
CREATE INDEX "ContentHashtag_contentType_contentId_idx" ON "ContentHashtag"("contentType", "contentId");

-- CreateIndex
CREATE INDEX "ContentHashtag_hashtagId_createdAt_idx" ON "ContentHashtag"("hashtagId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentHashtag_createdAt_idx" ON "ContentHashtag"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Mention_contentType_contentId_mentionedUserId_key" ON "Mention"("contentType", "contentId", "mentionedUserId");

-- CreateIndex
CREATE INDEX "Mention_mentionedUserId_idx" ON "Mention"("mentionedUserId");

-- AddForeignKey
ALTER TABLE "ContentHashtag" ADD CONSTRAINT "ContentHashtag_hashtagId_fkey" FOREIGN KEY ("hashtagId") REFERENCES "Hashtag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mention" ADD CONSTRAINT "Mention_mentionedUserId_fkey" FOREIGN KEY ("mentionedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
