CREATE TYPE "GroupCallType" AS ENUM ('AUDIO','VIDEO');
CREATE TYPE "GroupCallStatus" AS ENUM ('ACTIVE','ENDED');
CREATE TABLE "GroupCall" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "hostId" TEXT NOT NULL,
  "type" "GroupCallType" NOT NULL,
  "status" "GroupCallStatus" NOT NULL DEFAULT 'ACTIVE',
  "room" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt" TIMESTAMP(3),
  CONSTRAINT "GroupCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupCall_room_key" UNIQUE ("room"),
  CONSTRAINT "GroupCall_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GroupCall_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "GroupCall_conversationId_status_idx" ON "GroupCall"("conversationId","status");
CREATE TABLE "GroupCallParticipant" (
  "id" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt" TIMESTAMP(3),
  CONSTRAINT "GroupCallParticipant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupCallParticipant_callId_userId_key" UNIQUE ("callId","userId"),
  CONSTRAINT "GroupCallParticipant_callId_fkey" FOREIGN KEY ("callId") REFERENCES "GroupCall"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "GroupCallParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "GroupCallParticipant_callId_joinedAt_idx" ON "GroupCallParticipant"("callId","joinedAt");
