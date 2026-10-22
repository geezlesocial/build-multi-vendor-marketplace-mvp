ALTER TABLE "User" ADD COLUMN "avatarMediaId" TEXT;

CREATE UNIQUE INDEX "User_avatarMediaId_key" ON "User"("avatarMediaId");

ALTER TABLE "User"
ADD CONSTRAINT "User_avatarMediaId_fkey"
FOREIGN KEY ("avatarMediaId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
