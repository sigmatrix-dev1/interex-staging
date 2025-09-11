-- AlterTable
ALTER TABLE "PostpayLetter" ADD COLUMN "firstViewedAt" DATETIME;

-- AlterTable
ALTER TABLE "PostpayOtherLetter" ADD COLUMN "firstViewedAt" DATETIME;

-- AlterTable
ALTER TABLE "PrepayLetter" ADD COLUMN "firstViewedAt" DATETIME;
