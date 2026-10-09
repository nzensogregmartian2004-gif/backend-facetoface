-- Vocaux : durée du fichier audio (ms), déclarée par le client.
ALTER TABLE "Message" ADD COLUMN "mediaDurationMs" INTEGER;
