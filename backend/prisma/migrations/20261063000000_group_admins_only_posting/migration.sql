-- Groupe : publication réservée aux administrateurs (désactivé par défaut).
ALTER TABLE "Conversation" ADD COLUMN "adminsOnlyPosting" BOOLEAN NOT NULL DEFAULT false;
