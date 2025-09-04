-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "afterHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "beforeHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "requestId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "spanId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "traceId" TEXT;

-- CreateTable
CREATE TABLE "AppLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "module" TEXT,
    "event" TEXT,
    "message" TEXT,
    "requestId" TEXT,
    "traceId" TEXT,
    "spanId" TEXT,
    "method" TEXT,
    "route" TEXT,
    "status" INTEGER,
    "latencyMs" INTEGER,
    "clientIp" TEXT,
    "userAgent" TEXT,
    "customerId" TEXT,
    "providerId" TEXT,
    "userId" TEXT,
    "data" JSONB
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "message" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "customerId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "data" JSONB
);

-- CreateIndex
CREATE INDEX "AppLog_createdAt_idx" ON "AppLog"("createdAt");

-- CreateIndex
CREATE INDEX "AppLog_level_createdAt_idx" ON "AppLog"("level", "createdAt");

-- CreateIndex
CREATE INDEX "AppLog_module_event_createdAt_idx" ON "AppLog"("module", "event", "createdAt");

-- CreateIndex
CREATE INDEX "AppLog_requestId_createdAt_idx" ON "AppLog"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "AppLog_customerId_createdAt_idx" ON "AppLog"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_kind_createdAt_idx" ON "SecurityEvent"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SecurityEvent_customerId_createdAt_idx" ON "SecurityEvent"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_requestId_createdAt_idx" ON "AuditLog"("requestId", "createdAt");
