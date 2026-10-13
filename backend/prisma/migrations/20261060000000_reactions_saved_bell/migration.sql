-- CreateTable
CREATE TABLE "Dislike" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" "ContentTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Dislike_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedContent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetType" "ContentTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedContent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Follow" ADD COLUMN "notifyOn" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Dislike_targetType_targetId_idx" ON "Dislike"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "Dislike_userId_createdAt_idx" ON "Dislike"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Dislike_userId_targetType_targetId_key" ON "Dislike"("userId", "targetType", "targetId");

-- CreateIndex
CREATE INDEX "SavedContent_userId_createdAt_idx" ON "SavedContent"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SavedContent_userId_targetType_targetId_key" ON "SavedContent"("userId", "targetType", "targetId");

-- AddForeignKey
ALTER TABLE "Dislike" ADD CONSTRAINT "Dislike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedContent" ADD CONSTRAINT "SavedContent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
