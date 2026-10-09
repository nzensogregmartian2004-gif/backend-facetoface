-- Step 5: multi-member groups, roles, settings and invitations
CREATE TYPE "ConversationMemberRole" AS ENUM ('ADMIN', 'MEMBER');
ALTER TYPE "ReportTargetType" ADD VALUE IF NOT EXISTS 'GROUP';
-- (déplacé vers 20261029000000_step0_reconciliation : le type est créé à l’étape 19)

ALTER TABLE "Conversation"
  ALTER COLUMN "pairKey" DROP NOT NULL,
  ADD COLUMN "isGroup" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "name" VARCHAR(120),
  ADD COLUMN "photoKey" VARCHAR(300),
  ADD COLUMN "description" VARCHAR(500),
  ADD COLUMN "allowPaidContent" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "ConversationMember"
  ADD COLUMN "role" "ConversationMemberRole" NOT NULL DEFAULT 'MEMBER';
CREATE INDEX "ConversationMember_conversationId_role_idx" ON "ConversationMember"("conversationId", "role");
CREATE INDEX "Conversation_isGroup_lastMessageAt_idx" ON "Conversation"("isGroup", "lastMessageAt");

CREATE TABLE "ConversationInvite" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "token" VARCHAR(96) NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "maxUses" INTEGER,
  "uses" INTEGER NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationInvite_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConversationInvite_token_key" ON "ConversationInvite"("token");
CREATE INDEX "ConversationInvite_conversationId_revokedAt_idx" ON "ConversationInvite"("conversationId", "revokedAt");
ALTER TABLE "ConversationInvite" ADD CONSTRAINT "ConversationInvite_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationInvite" ADD CONSTRAINT "ConversationInvite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

