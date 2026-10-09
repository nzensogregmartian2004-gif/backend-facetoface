-- Coches de lecture, présence, archivage, « supprimer pour moi », favoris, accusés de lecture.
ALTER TABLE "User" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "showReadReceipts" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ConversationMember" ADD COLUMN "lastDeliveredAt" TIMESTAMP(3);
ALTER TABLE "ConversationMember" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE TABLE "HiddenMessage" (
  "messageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HiddenMessage_pkey" PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX "HiddenMessage_userId_idx" ON "HiddenMessage"("userId");
ALTER TABLE "HiddenMessage" ADD CONSTRAINT "HiddenMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HiddenMessage" ADD CONSTRAINT "HiddenMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StarredMessage" (
  "messageId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StarredMessage_pkey" PRIMARY KEY ("messageId", "userId")
);
CREATE INDEX "StarredMessage_userId_createdAt_idx" ON "StarredMessage"("userId", "createdAt");
ALTER TABLE "StarredMessage" ADD CONSTRAINT "StarredMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StarredMessage" ADD CONSTRAINT "StarredMessage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
