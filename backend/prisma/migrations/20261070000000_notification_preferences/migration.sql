-- Préférences de notification par catégorie (NULL = tout activé).
ALTER TABLE "User" ADD COLUMN "notifyPrefs" JSONB;
