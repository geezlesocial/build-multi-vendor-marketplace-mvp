CREATE TABLE "JimaRuntimeMetric" (
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "outcome" VARCHAR(20) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "JimaRuntimeMetric_pkey" PRIMARY KEY ("bucketStart", "outcome")
);

CREATE INDEX "JimaRuntimeMetric_bucketStart_idx" ON "JimaRuntimeMetric"("bucketStart");
