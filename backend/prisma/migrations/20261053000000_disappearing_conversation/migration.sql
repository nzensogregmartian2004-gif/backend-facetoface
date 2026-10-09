-- Messages éphémères : le réglage passe de la conversation entière (et non plus de chaque membre).
-- Reprise de la valeur la plus élevée déjà réglée par l'un des membres.
ALTER TABLE "Conversation" ADD COLUMN "disappearingSeconds" INTEGER;
UPDATE "Conversation" AS c
SET "disappearingSeconds" = s.mx
FROM (SELECT "conversationId", MAX("disappearingSeconds") AS mx FROM "ConversationMember" WHERE "disappearingSeconds" IS NOT NULL GROUP BY "conversationId") AS s
WHERE s."conversationId" = c."id";
ALTER TABLE "ConversationMember" DROP COLUMN "disappearingSeconds";
