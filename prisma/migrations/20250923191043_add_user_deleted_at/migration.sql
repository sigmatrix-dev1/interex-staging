-- AlterTable
ALTER TABLE "User" ADD COLUMN "deletedAt" DATETIME;

-- CreateIndex
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");
