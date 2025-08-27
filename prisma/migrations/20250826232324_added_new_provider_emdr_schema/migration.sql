-- CreateTable
CREATE TABLE "ProviderListDetail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerId" TEXT NOT NULL,
    "providerNpi" TEXT NOT NULL,
    "pcgProviderId" TEXT,
    "lastSubmittedTransaction" TEXT,
    "registeredForEmdr" BOOLEAN NOT NULL DEFAULT false,
    "registeredForEmdrElectronicOnly" BOOLEAN NOT NULL DEFAULT false,
    "stage" TEXT,
    "regStatus" TEXT,
    "status" TEXT,
    "esMDTransactionID" TEXT,
    "providerName" TEXT,
    "providerStreet" TEXT,
    "providerStreet2" TEXT,
    "providerCity" TEXT,
    "providerState" TEXT,
    "providerZip" TEXT,
    "transactionIdList" TEXT,
    "notificationDetails" JSONB,
    "statusChanges" JSONB,
    "errors" JSONB,
    "errorList" JSONB,
    CONSTRAINT "ProviderListDetail_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProviderRegistrationStatus" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "providerId" TEXT NOT NULL,
    "providerNpi" TEXT NOT NULL,
    "pcgProviderId" TEXT NOT NULL,
    "regStatus" TEXT,
    "stage" TEXT,
    "submissionStatus" TEXT,
    "status" TEXT,
    "callErrorCode" TEXT,
    "callErrorDescription" TEXT,
    "providerName" TEXT,
    "providerStreet" TEXT,
    "providerStreet2" TEXT,
    "providerCity" TEXT,
    "providerState" TEXT,
    "providerZip" TEXT,
    "transactionIdList" TEXT,
    "statusChanges" JSONB,
    "errors" JSONB,
    "errorList" JSONB,
    CONSTRAINT "ProviderRegistrationStatus_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ProviderListDetail_providerId_key" ON "ProviderListDetail"("providerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderRegistrationStatus_providerId_key" ON "ProviderRegistrationStatus"("providerId");
