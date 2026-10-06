-- Étape 5 — messagerie, messages payants et notifications.
CREATE TYPE "MessageKind" AS ENUM ('TEXT', 'MEDIA');
CREATE TYPE "PurchaseStatus" AS ENUM ('PENDING', 'PAID', 'FAILED');
CREATE TYPE "NotificationType" AS ENUM (
  'NEW_MESSAGE',
  'MESSAGE_PURCHASED',
  'CREATOR_SUBSCRIPTION_PURCHASED',
  'CREATOR_SUBSCRIPTION_CANCELLED',
  'CUSTOM_VIDEO_REQUESTED',
  'CUSTOM_VIDEO_PAYMENT_CONFIRMED',
  'CUSTOM_VIDEO_DELIVERED',
  'CUSTOM_VIDEO_COMPLETED',
  'CUSTOM_VIDEO_DECLINED'
);

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "pairKey" TEXT NOT NULL,
  "lastMessageAt" TIMESTAMP(3),
  "lastMessageId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Conversation_pairKey_key" ON "Conversation"("pairKey");
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

CREATE TABLE "ConversationMember" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastReadAt" TIMESTAMP(3),
  "unreadCount" INTEGER NOT NULL DEFAULT 0,
  "hiddenAt" TIMESTAMP(3),
  "clearedAt" TIMESTAMP(3),
  CONSTRAINT "ConversationMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConversationMember_conversationId_userId_key" ON "ConversationMember"("conversationId", "userId");
CREATE INDEX "ConversationMember_userId_hiddenAt_idx" ON "ConversationMember"("userId", "hiddenAt");
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationMember" ADD CONSTRAINT "ConversationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "kind" "MessageKind" NOT NULL,
  "text" TEXT,
  "mediaKey" TEXT,
  "mediaMime" TEXT,
  "mediaSize" INTEGER,
  "priceFcfa" INTEGER,
  "clientId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Message_senderId_clientId_key" ON "Message"("senderId", "clientId");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MessagePurchase" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "buyerId" TEXT NOT NULL,
  "sellerId" TEXT NOT NULL,
  "grossFcfa" INTEGER NOT NULL,
  "commissionFcfa" INTEGER NOT NULL,
  "creatorFcfa" INTEGER NOT NULL,
  "commissionBps" INTEGER NOT NULL,
  "status" "PurchaseStatus" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  CONSTRAINT "MessagePurchase_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MessagePurchase_messageId_buyerId_key" ON "MessagePurchase"("messageId", "buyerId");
CREATE INDEX "MessagePurchase_sellerId_status_idx" ON "MessagePurchase"("sellerId", "status");
ALTER TABLE "MessagePurchase" ADD CONSTRAINT "MessagePurchase_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessagePurchase" ADD CONSTRAINT "MessagePurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MessagePurchase" ADD CONSTRAINT "MessagePurchase_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "actorId" TEXT,
  "targetType" TEXT,
  "targetId" TEXT,
  "count" INTEGER NOT NULL DEFAULT 1,
  "amountFcfa" INTEGER,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
