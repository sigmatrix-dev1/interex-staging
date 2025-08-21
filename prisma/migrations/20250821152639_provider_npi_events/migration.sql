-- CreateTable
CREATE TABLE "ProviderEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "message" TEXT,
    "payload" JSONB,
    "providerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "actorId" TEXT,
    CONSTRAINT "ProviderEvent_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProviderEvent_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProviderEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ProviderEvent_providerId_idx" ON "ProviderEvent"("providerId");

-- CreateIndex
CREATE INDEX "ProviderEvent_customerId_createdAt_idx" ON "ProviderEvent"("customerId", "createdAt");
