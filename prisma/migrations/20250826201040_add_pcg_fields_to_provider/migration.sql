-- AlterTable
ALTER TABLE "Provider" ADD COLUMN "pcgProviderId" TEXT;
ALTER TABLE "Provider" ADD COLUMN "pcgUpdateAt" DATETIME;
ALTER TABLE "Provider" ADD COLUMN "pcgUpdateResponse" JSONB;
ALTER TABLE "Provider" ADD COLUMN "providerCity" TEXT;
ALTER TABLE "Provider" ADD COLUMN "providerState" TEXT;
ALTER TABLE "Provider" ADD COLUMN "providerStreet" TEXT;
ALTER TABLE "Provider" ADD COLUMN "providerStreet2" TEXT;
ALTER TABLE "Provider" ADD COLUMN "providerZip" TEXT;
