-- Étape 14 : profil créateur en chaîne (bannière, contenu mis en avant). Migration additive.
-- CreateEnum
CREATE TYPE "FeaturedContentType" AS ENUM ('VIDEO', 'SHORT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "bannerUrl" TEXT,
ADD COLUMN "featuredContentId" TEXT,
ADD COLUMN "featuredContentType" "FeaturedContentType";
