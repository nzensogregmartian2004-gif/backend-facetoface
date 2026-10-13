-- Sondages, événements et localisation dans la messagerie.
ALTER TYPE "MessageKind" ADD VALUE 'POLL';
ALTER TYPE "MessageKind" ADD VALUE 'EVENT';
ALTER TYPE "MessageKind" ADD VALUE 'LOCATION';

ALTER TABLE "Message" ADD COLUMN "latitude" DOUBLE PRECISION, ADD COLUMN "longitude" DOUBLE PRECISION, ADD COLUMN "placeLabel" TEXT, ADD COLUMN "eventTitle" TEXT, ADD COLUMN "eventStartsAt" TIMESTAMP(3), ADD COLUMN "eventPlace" TEXT;

CREATE TABLE "Poll" (
  "id" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "question" VARCHAR(200) NOT NULL,
  "allowMultiple" BOOLEAN NOT NULL DEFAULT false,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "Poll_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Poll_messageId_key" ON "Poll"("messageId");
ALTER TABLE "Poll" ADD CONSTRAINT "Poll_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PollOption" (
  "id" TEXT NOT NULL,
  "pollId" TEXT NOT NULL,
  "text" VARCHAR(100) NOT NULL,
  "position" INTEGER NOT NULL,
  CONSTRAINT "PollOption_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PollOption_pollId_idx" ON "PollOption"("pollId");
ALTER TABLE "PollOption" ADD CONSTRAINT "PollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "Poll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PollVote" (
  "id" TEXT NOT NULL,
  "optionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PollVote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PollVote_optionId_userId_key" ON "PollVote"("optionId", "userId");
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "PollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PollVote" ADD CONSTRAINT "PollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
