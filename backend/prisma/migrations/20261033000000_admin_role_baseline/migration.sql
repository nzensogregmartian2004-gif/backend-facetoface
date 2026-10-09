-- Base des rôles administrateur, antérieure à l'étape 7 (révision).
-- Le schéma déclarait « adminRole » sans migration qui le crée : sur une base vide, l'enchaînement échouait.
-- Migration idempotente : sur une base qui possède déjà la colonne, elle ne fait rien.
DO $$ BEGIN
  CREATE TYPE "AdminRole" AS ENUM ('USER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "adminRole" "AdminRole";
CREATE INDEX IF NOT EXISTS "User_adminRole_idx" ON "User"("adminRole");
