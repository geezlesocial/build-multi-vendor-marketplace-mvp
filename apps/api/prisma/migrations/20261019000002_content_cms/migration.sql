-- Additive content CMS migration. Existing commerce/live-shopping history is preserved.
ALTER TYPE "Role" ADD VALUE 'CONTENT_EDITOR';
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "ContentPageType" AS ENUM ('STANDARD', 'ABOUT', 'TERMS', 'PRIVACY', 'POLICY', 'HELP', 'LANDING');
CREATE TYPE "NavigationPlacement" AS ENUM ('NONE', 'HEADER', 'FOOTER', 'BOTH');
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO', 'CAPTION', 'DOCUMENT');
CREATE TYPE "MediaScanStatus" AS ENUM ('QUARANTINED', 'APPROVED', 'REJECTED');

CREATE TABLE "BlogCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlogCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BlogCategory_slug_key" ON "BlogCategory"("slug");

CREATE TABLE "BlogTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    CONSTRAINT "BlogTag_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BlogTag_slug_key" ON "BlogTag"("slug");

CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "safeName" TEXT NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "detectedMime" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "checksum" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "altText" TEXT,
    "caption" TEXT,
    "scanStatus" "MediaScanStatus" NOT NULL DEFAULT 'QUARANTINED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");
CREATE INDEX "MediaAsset_scanStatus_kind_createdAt_idx" ON "MediaAsset"("scanStatus", "kind", "createdAt");

CREATE TABLE "BlogPost" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "excerpt" TEXT,
    "bodyJson" JSONB NOT NULL,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "categoryId" TEXT,
    "authorId" TEXT NOT NULL,
    "editorId" TEXT NOT NULL,
    "featuredImageId" TEXT,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "ogImageId" TEXT,
    "canonicalUrl" TEXT,
    "noIndex" BOOLEAN NOT NULL DEFAULT false,
    "noFollow" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BlogPost_slug_key" ON "BlogPost"("slug");
CREATE INDEX "BlogPost_status_publishedAt_idx" ON "BlogPost"("status", "publishedAt");
CREATE INDEX "BlogPost_categoryId_status_idx" ON "BlogPost"("categoryId", "status");

CREATE TABLE "BlogPostTag" (
    "postId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    CONSTRAINT "BlogPostTag_pkey" PRIMARY KEY ("postId", "tagId")
);
CREATE TABLE "BlogPostRevision" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "excerpt" TEXT,
    "bodyJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "editorId" TEXT NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlogPostRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BlogPostRevision_postId_revisionNumber_key" ON "BlogPostRevision"("postId", "revisionNumber");
CREATE INDEX "BlogPostRevision_postId_createdAt_idx" ON "BlogPostRevision"("postId", "createdAt");

CREATE TABLE "ContentPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyJson" JSONB NOT NULL,
    "pageType" "ContentPageType" NOT NULL DEFAULT 'STANDARD',
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "parentId" TEXT,
    "editorId" TEXT NOT NULL,
    "navPlacement" "NavigationPlacement" NOT NULL DEFAULT 'NONE',
    "navLabel" TEXT,
    "navOrder" INTEGER NOT NULL DEFAULT 0,
    "seoTitle" TEXT,
    "seoDescription" TEXT,
    "ogImageId" TEXT,
    "canonicalUrl" TEXT,
    "noIndex" BOOLEAN NOT NULL DEFAULT false,
    "noFollow" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ContentPage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentPage_slug_key" ON "ContentPage"("slug");
CREATE INDEX "ContentPage_status_publishedAt_idx" ON "ContentPage"("status", "publishedAt");
CREATE INDEX "ContentPage_parentId_navPlacement_navOrder_idx" ON "ContentPage"("parentId", "navPlacement", "navOrder");
CREATE TABLE "ContentPageRevision" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "bodyJson" JSONB NOT NULL,
    "metadataJson" JSONB,
    "editorId" TEXT NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentPageRevision_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentPageRevision_pageId_revisionNumber_key" ON "ContentPageRevision"("pageId", "revisionNumber");
CREATE INDEX "ContentPageRevision_pageId_createdAt_idx" ON "ContentPageRevision"("pageId", "createdAt");

CREATE TABLE "SlugRedirect" (
    "id" TEXT NOT NULL,
    "fromPath" TEXT NOT NULL,
    "destinationPath" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SlugRedirect_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SlugRedirect_fromPath_key" ON "SlugRedirect"("fromPath");
CREATE INDEX "SlugRedirect_destinationPath_idx" ON "SlugRedirect"("destinationPath");

CREATE TABLE "ContentPreviewToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "postId" TEXT,
    "pageId" TEXT,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContentPreviewToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentPreviewToken_tokenHash_key" ON "ContentPreviewToken"("tokenHash");
CREATE INDEX "ContentPreviewToken_expiresAt_idx" ON "ContentPreviewToken"("expiresAt");

ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "BlogCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_featuredImageId_fkey" FOREIGN KEY ("featuredImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlogPost" ADD CONSTRAINT "BlogPost_ogImageId_fkey" FOREIGN KEY ("ogImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BlogPostTag" ADD CONSTRAINT "BlogPostTag_postId_fkey" FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogPostTag" ADD CONSTRAINT "BlogPostTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "BlogTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogPostRevision" ADD CONSTRAINT "BlogPostRevision_postId_fkey" FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlogPostRevision" ADD CONSTRAINT "BlogPostRevision_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ContentPage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentPage" ADD CONSTRAINT "ContentPage_ogImageId_fkey" FOREIGN KEY ("ogImageId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContentPageRevision" ADD CONSTRAINT "ContentPageRevision_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ContentPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentPageRevision" ADD CONSTRAINT "ContentPageRevision_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContentPreviewToken" ADD CONSTRAINT "ContentPreviewToken_postId_fkey" FOREIGN KEY ("postId") REFERENCES "BlogPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentPreviewToken" ADD CONSTRAINT "ContentPreviewToken_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "ContentPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentPreviewToken" ADD CONSTRAINT "ContentPreviewToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
