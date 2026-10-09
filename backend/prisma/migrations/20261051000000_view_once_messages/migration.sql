-- Messages à vue unique (photos et vidéos) : un destinataire par membre, ouverture unique par destinataire.
ALTER TABLE "Message" ADD COLUMN "viewOnce" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Message_viewOnce_idx" ON "Message"("viewOnce");

CREATE TABLE "ViewOnceRecipient" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ViewOnceRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ViewOnceRecipient_messageId_userId_key" ON "ViewOnceRecipient"("messageId", "userId");
CREATE INDEX "ViewOnceRecipient_userId_openedAt_idx" ON "ViewOnceRecipient"("userId", "openedAt");
ALTER TABLE "ViewOnceRecipient" ADD CONSTRAINT "ViewOnceRecipient_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ViewOnceRecipient" ADD CONSTRAINT "ViewOnceRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
