/*
  Warnings:

  - You are about to drop the `AuditLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to alter the column `metadata` on the `UserNotification` table. The data in that column could be lost. The data in that column will be cast from `String` to `Json`.

*/
-- DropIndex
DROP INDEX "AuditLog_requestId_createdAt_idx";

-- DropIndex
DROP INDEX "AuditLog_customerId_createdAt_idx";

-- DropIndex
DROP INDEX "AuditLog_userId_createdAt_idx";

-- DropIndex
DROP INDEX "AuditLog_entityType_entityId_idx";

-- DropIndex
DROP INDEX "AuditLog_action_createdAt_idx";

-- DropIndex
DROP INDEX "AuditLog_createdAt_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AuditLog";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_UserNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "readAt" DATETIME,
    "dismissedAt" DATETIME,
    "expiresAt" DATETIME,
    "actionUrl" TEXT,
    "groupKey" TEXT,
    "metadata" JSONB,
    CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_UserNotification" ("actionUrl", "createdAt", "description", "dismissedAt", "expiresAt", "groupKey", "id", "kind", "metadata", "readAt", "title", "updatedAt", "userId") SELECT "actionUrl", "createdAt", "description", "dismissedAt", "expiresAt", "groupKey", "id", "kind", "metadata", "readAt", "title", "updatedAt", "userId" FROM "UserNotification";
DROP TABLE "UserNotification";
ALTER TABLE "new_UserNotification" RENAME TO "UserNotification";
CREATE INDEX "UserNotification_userId_createdAt_idx" ON "UserNotification"("userId", "createdAt");
CREATE INDEX "UserNotification_userId_readAt_idx" ON "UserNotification"("userId", "readAt");
CREATE INDEX "UserNotification_userId_dismissedAt_idx" ON "UserNotification"("userId", "dismissedAt");
CREATE INDEX "UserNotification_userId_expiresAt_idx" ON "UserNotification"("userId", "expiresAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
