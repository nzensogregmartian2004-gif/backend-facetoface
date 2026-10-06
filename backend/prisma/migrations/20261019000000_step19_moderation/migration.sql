-- Étape 19 — Modération et sécurité
CREATE TYPE "ModerationTargetType" AS ENUM ('USER','VIDEO','SHORT','LIVE','COMMENT','MESSAGE','PAID_CONTENT');
CREATE TYPE "ModerationActionType" AS ENUM ('WARNING','HIDE','UNHIDE','REMOVE','RESTORE','SUSPEND','BAN','UNSUSPEND','UNBAN','DISABLE_MONETIZATION','ENABLE_MONETIZATION');
CREATE TYPE "ProfileModerationStatus" AS ENUM ('ACTIVE','HIDDEN');
CREATE TYPE "ModerationContentStatus" AS ENUM ('ACTIVE','HIDDEN','REMOVED');

ALTER TABLE "User"
  ADD COLUMN "profileModerationStatus" "ProfileModerationStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "monetizationDisabledAt" TIMESTAMP(3),
  ADD COLUMN "monetizationDisabledReason" TEXT;

ALTER TABLE "Live"
  ADD COLUMN "moderationStatus" "ModerationContentStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "Comment"
  ADD COLUMN "moderationStatus" "ModerationContentStatus" NOT NULL DEFAULT 'ACTIVE';

ALTER TABLE "Message"
  ADD COLUMN "moderationStatus" "ModerationContentStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE "ModerationAction" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "action" "ModerationActionType" NOT NULL,
  "targetType" "ModerationTargetType" NOT NULL,
  "targetId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "reportId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "targetUserId" TEXT,
  "targetVideoId" TEXT,
  "targetShortId" TEXT,
  "targetLiveId" TEXT,
  "targetCommentId" TEXT,
  "targetMessageId" TEXT,
  CONSTRAINT "ModerationAction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModerationAction_targetType_targetId_createdAt_idx" ON "ModerationAction"("targetType","targetId","createdAt");
CREATE INDEX "ModerationAction_adminId_createdAt_idx" ON "ModerationAction"("adminId","createdAt");
CREATE INDEX "ModerationAction_reportId_idx" ON "ModerationAction"("reportId");

ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetVideoId_fkey" FOREIGN KEY ("targetVideoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetShortId_fkey" FOREIGN KEY ("targetShortId") REFERENCES "Short"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetLiveId_fkey" FOREIGN KEY ("targetLiveId") REFERENCES "Live"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetCommentId_fkey" FOREIGN KEY ("targetCommentId") REFERENCES "Comment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ModerationAction" ADD CONSTRAINT "ModerationAction_targetMessageId_fkey" FOREIGN KEY ("targetMessageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
