-- Litiges : réponse du créateur et clôture ; contenu : date de retrait (purge après délai).
ALTER TABLE "Call" ADD COLUMN "disputeResponse" TEXT, ADD COLUMN "disputeRespondedAt" TIMESTAMP(3), ADD COLUMN "disputeClosedAt" TIMESTAMP(3);
ALTER TABLE "CustomVideoRequest" ADD COLUMN "disputeResponse" TEXT, ADD COLUMN "disputeRespondedAt" TIMESTAMP(3), ADD COLUMN "disputeClosedAt" TIMESTAMP(3);
ALTER TABLE "Video" ADD COLUMN "removedAt" TIMESTAMP(3);
ALTER TABLE "Short" ADD COLUMN "removedAt" TIMESTAMP(3);
