ALTER TABLE "MarketplaceSettings" ADD COLUMN "jimaConfig" JSONB;

CREATE TABLE "JimaConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JimaConversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JimaConversation_userId_updatedAt_idx" ON "JimaConversation"("userId", "updatedAt");
ALTER TABLE "JimaConversation" ADD CONSTRAINT "JimaConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JimaMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" VARCHAR(12) NOT NULL,
    "content" VARCHAR(4000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JimaMessage_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JimaMessage_conversationId_createdAt_idx" ON "JimaMessage"("conversationId", "createdAt");
ALTER TABLE "JimaMessage" ADD CONSTRAINT "JimaMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "JimaConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JimaKnowledgeArticle" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "body" VARCHAR(8000) NOT NULL,
    "audience" VARCHAR(16) NOT NULL DEFAULT 'PUBLIC',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JimaKnowledgeArticle_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JimaKnowledgeArticle_published_audience_updatedAt_idx" ON "JimaKnowledgeArticle"("published", "audience", "updatedAt");
