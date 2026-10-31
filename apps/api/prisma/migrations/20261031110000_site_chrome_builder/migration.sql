CREATE TABLE "SiteChromeConfiguration" (
    "id" TEXT NOT NULL,
    "storeId" TEXT,
    "draftJson" JSONB NOT NULL,
    "publishedJson" JSONB,
    "draftVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedVersion" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteChromeConfiguration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteChromeConfiguration_storeId_key" ON "SiteChromeConfiguration"("storeId");
CREATE INDEX "SiteChromeConfiguration_publishedVersion_publishedAt_idx" ON "SiteChromeConfiguration"("publishedVersion", "publishedAt");
ALTER TABLE "SiteChromeConfiguration" ADD CONSTRAINT "SiteChromeConfiguration_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SiteChromeRevision" (
    "id" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configurationJson" JSONB NOT NULL,
    "editorId" TEXT NOT NULL,
    "changeNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SiteChromeRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteChromeRevision_configurationId_version_key" ON "SiteChromeRevision"("configurationId", "version");
CREATE INDEX "SiteChromeRevision_configurationId_createdAt_idx" ON "SiteChromeRevision"("configurationId", "createdAt");
ALTER TABLE "SiteChromeRevision" ADD CONSTRAINT "SiteChromeRevision_configurationId_fkey" FOREIGN KEY ("configurationId") REFERENCES "SiteChromeConfiguration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteChromeRevision" ADD CONSTRAINT "SiteChromeRevision_editorId_fkey" FOREIGN KEY ("editorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
