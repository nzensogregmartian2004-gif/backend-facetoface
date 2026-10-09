-- Étape 0 — réconciliation des valeurs d'enum utilisées par le code mais absentes des migrations précédentes.
-- Toutes les instructions sont idempotentes (IF NOT EXISTS) : sans effet sur une base qui les possède déjà.

ALTER TYPE "ModerationTargetType" ADD VALUE IF NOT EXISTS 'GROUP';

ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FOLLOW';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CALL_INCOMING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'LIVE_STARTED';

ALTER TYPE "CreatorEarningSource" ADD VALUE IF NOT EXISTS 'ATTACHMENT';

-- Instructions reportées depuis 20261007230000 (step5) et 20261007230000 (step8) : elles référencent des tables
-- créées par des migrations de date ultérieure (ModerationAction : step19 ; Live : step10). Idempotentes.
ALTER TABLE "ModerationAction" ADD COLUMN IF NOT EXISTS "targetConversationId" TEXT;
CREATE INDEX IF NOT EXISTS "ModerationAction_targetConversationId_idx" ON "ModerationAction"("targetConversationId");
DO $$ BEGIN
  ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetConversationId_fkey"
    FOREIGN KEY ("targetConversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CoinGiftTransaction" ADD CONSTRAINT "CoinGiftTransaction_liveId_fkey"
    FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "CoinTipTransaction" ADD CONSTRAINT "CoinTipTransaction_liveId_fkey"
    FOREIGN KEY ("liveId") REFERENCES "Live"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
