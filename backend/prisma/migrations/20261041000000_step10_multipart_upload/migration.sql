-- Étape 10 lot 3 : sessions d'envoi par parties (additif uniquement).

-- CreateTable
CREATE TABLE "ContentUploadSession" (
    "id" TEXT NOT NULL,
    "contentType" "ContentTargetType" NOT NULL,
    "contentId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "partSizeBytes" INTEGER NOT NULL,
    "partCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentUploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContentUploadSession_contentType_contentId_key" ON "ContentUploadSession"("contentType", "contentId");
