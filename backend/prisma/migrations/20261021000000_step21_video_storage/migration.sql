CREATE TYPE "VideoProcessingStatus" AS ENUM ('PENDING','PROCESSING','READY','FAILED');

ALTER TABLE "Video" ADD COLUMN "processingStatus" "VideoProcessingStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Video" ADD COLUMN "processingError" TEXT;
ALTER TABLE "Video" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "Video" ADD COLUMN "manifestKey" TEXT;

ALTER TABLE "Short" ADD COLUMN "processingStatus" "VideoProcessingStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Short" ADD COLUMN "processingError" TEXT;
ALTER TABLE "Short" ADD COLUMN "processedAt" TIMESTAMP(3);
ALTER TABLE "Short" ADD COLUMN "manifestKey" TEXT;

CREATE TABLE "VideoVariant" (
  "id" TEXT NOT NULL,
  "contentId" TEXT NOT NULL,
  "height" INTEGER NOT NULL,
  "width" INTEGER,
  "bitrateKbps" INTEGER,
  "mimeType" TEXT NOT NULL DEFAULT 'video/mp4',
  "objectKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "videoId" TEXT,
  "shortId" TEXT,
  CONSTRAINT "VideoVariant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VideoVariant_videoId_height_key" ON "VideoVariant"("videoId","height");
CREATE UNIQUE INDEX "VideoVariant_shortId_height_key" ON "VideoVariant"("shortId","height");
CREATE INDEX "VideoVariant_contentId_idx" ON "VideoVariant"("contentId");
ALTER TABLE "VideoVariant" ADD CONSTRAINT "VideoVariant_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoVariant" ADD CONSTRAINT "VideoVariant_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "Short"("id") ON DELETE CASCADE ON UPDATE CASCADE;
