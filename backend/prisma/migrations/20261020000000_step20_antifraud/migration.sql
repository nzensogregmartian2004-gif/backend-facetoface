CREATE TYPE "FraudStatus" AS ENUM ('CLEAR','REVIEW','BLOCKED');
CREATE TYPE "FraudEventType" AS ENUM ('VIEW','AD_IMPRESSION','AD_CLICK','PAYMENT');
CREATE TYPE "FraudDecision" AS ENUM ('ALLOW','REVIEW','BLOCK');

ALTER TABLE "User" ADD COLUMN "fraudStatus" "FraudStatus" NOT NULL DEFAULT 'CLEAR';
ALTER TABLE "User" ADD COLUMN "fraudScore" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "fraudFlaggedAt" TIMESTAMP(3);

CREATE TABLE "FraudEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "type" "FraudEventType" NOT NULL,
  "decision" "FraudDecision" NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "ipHash" VARCHAR(128),
  "userAgentHash" VARCHAR(128),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FraudEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FraudEvent_userId_type_createdAt_idx" ON "FraudEvent"("userId","type","createdAt");
CREATE INDEX "FraudEvent_ipHash_type_createdAt_idx" ON "FraudEvent"("ipHash","type","createdAt");
CREATE INDEX "FraudEvent_decision_createdAt_idx" ON "FraudEvent"("decision","createdAt");
ALTER TABLE "FraudEvent" ADD CONSTRAINT "FraudEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
