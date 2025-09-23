-- Migration: add UserNotification table
-- NOTE: This is a placeholder; run `prisma migrate dev` to apply.

CREATE TABLE "UserNotification" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "readAt" DATETIME,
  "dismissedAt" DATETIME,
  "expiresAt" DATETIME,
  "actionUrl" TEXT,
  "groupKey" TEXT,
  "metadata" TEXT,
  CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "UserNotification_userId_createdAt_idx" ON "UserNotification" ("userId", "createdAt");
CREATE INDEX "UserNotification_userId_readAt_idx" ON "UserNotification" ("userId", "readAt");
CREATE INDEX "UserNotification_userId_dismissedAt_idx" ON "UserNotification" ("userId", "dismissedAt");
CREATE INDEX "UserNotification_userId_expiresAt_idx" ON "UserNotification" ("userId", "expiresAt");
