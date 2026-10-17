-- Téléchargement d'un média de message : désactivé par défaut.
ALTER TABLE "Message" ADD COLUMN "downloadAllowed" BOOLEAN NOT NULL DEFAULT false;
