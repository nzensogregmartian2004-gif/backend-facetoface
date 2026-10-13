-- Favoris de conversation, par membre (le favori d’un membre n’affecte pas les autres).
ALTER TABLE "ConversationMember" ADD COLUMN "favoriteAt" TIMESTAMP(3);
