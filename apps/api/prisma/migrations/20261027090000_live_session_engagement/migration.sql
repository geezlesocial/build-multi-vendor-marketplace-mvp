CREATE TYPE "LiveSessionReactionKind" AS ENUM ('LIKE', 'LOVE', 'HAPPY', 'CONGRATS');

CREATE TABLE "LiveSessionReaction" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reaction" "LiveSessionReactionKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LiveSessionReaction_pkey" PRIMARY KEY ("sessionId", "userId")
);

CREATE TABLE "LiveSessionView" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "viewerKeyHash" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastViewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LiveSessionView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LiveSessionView_sessionId_viewerKeyHash_key" ON "LiveSessionView"("sessionId", "viewerKeyHash");
CREATE INDEX "LiveSessionReaction_sessionId_reaction_idx" ON "LiveSessionReaction"("sessionId", "reaction");
CREATE INDEX "LiveSessionReaction_userId_updatedAt_idx" ON "LiveSessionReaction"("userId", "updatedAt");
CREATE INDEX "LiveSessionView_sessionId_lastViewedAt_idx" ON "LiveSessionView"("sessionId", "lastViewedAt");

ALTER TABLE "LiveSessionReaction" ADD CONSTRAINT "LiveSessionReaction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveSessionReaction" ADD CONSTRAINT "LiveSessionReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LiveSessionView" ADD CONSTRAINT "LiveSessionView_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
