-- Commentaires vocaux (Shorts et vidéos longues) : texte optionnel, fichier audio privé unique.
ALTER TABLE "Comment" ALTER COLUMN "text" DROP NOT NULL;
ALTER TABLE "Comment" ADD COLUMN "audioKey" TEXT;
ALTER TABLE "Comment" ADD COLUMN "audioMime" TEXT;
ALTER TABLE "Comment" ADD COLUMN "audioSize" INTEGER;
ALTER TABLE "Comment" ADD COLUMN "audioDurationMs" INTEGER;
CREATE UNIQUE INDEX "Comment_audioKey_key" ON "Comment"("audioKey");
