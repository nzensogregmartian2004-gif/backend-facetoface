-- Étape 13 : découpage et couverture des vidéos (additif uniquement).

-- AlterTable
ALTER TABLE "Video" ADD COLUMN "editStartMs" INTEGER, ADD COLUMN "editEndMs" INTEGER, ADD COLUMN "coverMs" INTEGER;

-- AlterTable
ALTER TABLE "Short" ADD COLUMN "editStartMs" INTEGER, ADD COLUMN "editEndMs" INTEGER, ADD COLUMN "coverMs" INTEGER;
