-- CreateTable
CREATE TABLE "PrepayLetter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalLetterId" TEXT NOT NULL,
    "downloadId" TEXT,
    "providerNpi" TEXT NOT NULL,
    "providerId" TEXT,
    "customerId" TEXT,
    "providerGroupId" TEXT,
    "esmdTransactionId" TEXT,
    "hihDeliveryAt" DATETIME,
    "letterDate" DATETIME,
    "respondBy" DATETIME,
    "jurisdiction" TEXT,
    "programName" TEXT,
    "stage" TEXT,
    "language" TEXT,
    "bSendAck" BOOLEAN,
    "ackUniqueId" TEXT,
    "rcOid" TEXT,
    "letterName" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PrepayLetter_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PrepayLetter_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PrepayLetter_providerGroupId_fkey" FOREIGN KEY ("providerGroupId") REFERENCES "ProviderGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostpayLetter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalLetterId" TEXT NOT NULL,
    "downloadId" TEXT,
    "providerNpi" TEXT NOT NULL,
    "providerId" TEXT,
    "customerId" TEXT,
    "providerGroupId" TEXT,
    "esmdTransactionId" TEXT,
    "hihDeliveryAt" DATETIME,
    "letterDate" DATETIME,
    "respondBy" DATETIME,
    "jurisdiction" TEXT,
    "programName" TEXT,
    "stage" TEXT,
    "language" TEXT,
    "bSendAck" BOOLEAN,
    "ackUniqueId" TEXT,
    "rcOid" TEXT,
    "letterName" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PostpayLetter_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PostpayLetter_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PostpayLetter_providerGroupId_fkey" FOREIGN KEY ("providerGroupId") REFERENCES "ProviderGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostpayOtherLetter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "externalLetterId" TEXT NOT NULL,
    "downloadId" TEXT,
    "providerNpi" TEXT NOT NULL,
    "providerId" TEXT,
    "customerId" TEXT,
    "providerGroupId" TEXT,
    "esmdTransactionId" TEXT,
    "hihDeliveryAt" DATETIME,
    "letterDate" DATETIME,
    "respondBy" DATETIME,
    "jurisdiction" TEXT,
    "programName" TEXT,
    "stage" TEXT,
    "language" TEXT,
    "bSendAck" BOOLEAN,
    "ackUniqueId" TEXT,
    "rcOid" TEXT,
    "letterName" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PostpayOtherLetter_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PostpayOtherLetter_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PostpayOtherLetter_providerGroupId_fkey" FOREIGN KEY ("providerGroupId") REFERENCES "ProviderGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PrepayLetter_externalLetterId_key" ON "PrepayLetter"("externalLetterId");

-- CreateIndex
CREATE INDEX "PrepayLetter_customerId_idx" ON "PrepayLetter"("customerId");

-- CreateIndex
CREATE INDEX "PrepayLetter_providerNpi_idx" ON "PrepayLetter"("providerNpi");

-- CreateIndex
CREATE INDEX "PrepayLetter_letterDate_idx" ON "PrepayLetter"("letterDate");

-- CreateIndex
CREATE UNIQUE INDEX "PostpayLetter_externalLetterId_key" ON "PostpayLetter"("externalLetterId");

-- CreateIndex
CREATE INDEX "PostpayLetter_customerId_idx" ON "PostpayLetter"("customerId");

-- CreateIndex
CREATE INDEX "PostpayLetter_providerNpi_idx" ON "PostpayLetter"("providerNpi");

-- CreateIndex
CREATE INDEX "PostpayLetter_letterDate_idx" ON "PostpayLetter"("letterDate");

-- CreateIndex
CREATE UNIQUE INDEX "PostpayOtherLetter_externalLetterId_key" ON "PostpayOtherLetter"("externalLetterId");

-- CreateIndex
CREATE INDEX "PostpayOtherLetter_customerId_idx" ON "PostpayOtherLetter"("customerId");

-- CreateIndex
CREATE INDEX "PostpayOtherLetter_providerNpi_idx" ON "PostpayOtherLetter"("providerNpi");

-- CreateIndex
CREATE INDEX "PostpayOtherLetter_letterDate_idx" ON "PostpayOtherLetter"("letterDate");
