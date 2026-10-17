-- Restriction de compte : publication, commentaires, messages, lives et appels bloqués.
ALTER TYPE "ModerationActionType" ADD VALUE 'RESTRICT';
ALTER TYPE "ModerationActionType" ADD VALUE 'UNRESTRICT';
ALTER TABLE "User" ADD COLUMN "restrictedAt" TIMESTAMP(3);
