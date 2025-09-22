/*
  Warnings:

  - Made the column `id` on table `AuditEvent` required. This step will fail if there are existing NULL values in that column.
  - Made the column `id` on table `AuditEventArchive` required. This step will fail if there are existing NULL values in that column.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chainKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hashPrev" TEXT,
    "hashSelf" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorDisplay" TEXT,
    "actorIp" TEXT,
    "actorUserAgent" TEXT,
    "customerId" TEXT,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "entityType" TEXT,
    "entityId" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "spanId" TEXT,
    "summary" TEXT,
    "message" TEXT,
    "metadata" TEXT,
    "diff" TEXT,
    "phi" BOOLEAN NOT NULL DEFAULT false,
    "reserved1" TEXT,
    "reserved2" TEXT
);
INSERT INTO "new_AuditEvent" ("action", "actorDisplay", "actorId", "actorIp", "actorType", "actorUserAgent", "category", "chainKey", "createdAt", "customerId", "diff", "entityId", "entityType", "hashPrev", "hashSelf", "id", "message", "metadata", "phi", "requestId", "reserved1", "reserved2", "seq", "spanId", "status", "summary", "traceId") SELECT "action", "actorDisplay", "actorId", "actorIp", "actorType", "actorUserAgent", "category", "chainKey", "createdAt", "customerId", "diff", "entityId", "entityType", "hashPrev", "hashSelf", "id", "message", "metadata", "phi", "requestId", "reserved1", "reserved2", "seq", "spanId", "status", "summary", "traceId" FROM "AuditEvent";
DROP TABLE "AuditEvent";
ALTER TABLE "new_AuditEvent" RENAME TO "AuditEvent";
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
CREATE INDEX "AuditEvent_chainKey_seq_idx" ON "AuditEvent"("chainKey", "seq");
CREATE INDEX "AuditEvent_category_createdAt_idx" ON "AuditEvent"("category", "createdAt");
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");
CREATE INDEX "AuditEvent_customerId_createdAt_idx" ON "AuditEvent"("customerId", "createdAt");
CREATE INDEX "AuditEvent_requestId_createdAt_idx" ON "AuditEvent"("requestId", "createdAt");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");
CREATE TABLE "new_AuditEventArchive" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL,
    "chainKey" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "hashPrev" TEXT,
    "hashSelf" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "actorDisplay" TEXT,
    "actorIp" TEXT,
    "actorUserAgent" TEXT,
    "customerId" TEXT,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "spanId" TEXT,
    "summary" TEXT,
    "message" TEXT,
    "metadata" TEXT,
    "diff" TEXT,
    "phi" BOOLEAN NOT NULL DEFAULT false,
    "reserved1" TEXT,
    "reserved2" TEXT
);
INSERT INTO "new_AuditEventArchive" ("action", "actorDisplay", "actorId", "actorIp", "actorType", "actorUserAgent", "category", "chainKey", "createdAt", "customerId", "diff", "entityId", "entityType", "hashPrev", "hashSelf", "id", "message", "metadata", "phi", "requestId", "reserved1", "reserved2", "seq", "spanId", "status", "summary", "traceId") SELECT "action", "actorDisplay", "actorId", "actorIp", "actorType", "actorUserAgent", "category", "chainKey", "createdAt", "customerId", "diff", "entityId", "entityType", "hashPrev", "hashSelf", "id", "message", "metadata", "phi", "requestId", "reserved1", "reserved2", "seq", "spanId", "status", "summary", "traceId" FROM "AuditEventArchive";
DROP TABLE "AuditEventArchive";
ALTER TABLE "new_AuditEventArchive" RENAME TO "AuditEventArchive";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
