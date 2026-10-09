-- Étape 1 : clé d'idempotence des cadeaux et pourboires (anti double envoi). Additif : colonnes nullables, index uniques par expéditeur.
ALTER TABLE "CoinGiftTransaction" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "CoinTipTransaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "CoinGiftTransaction_senderId_idempotencyKey_key" ON "CoinGiftTransaction"("senderId", "idempotencyKey");
CREATE UNIQUE INDEX "CoinTipTransaction_senderId_idempotencyKey_key" ON "CoinTipTransaction"("senderId", "idempotencyKey");
