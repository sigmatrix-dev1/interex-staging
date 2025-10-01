-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" DATETIME,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "passwordChangedAt" DATETIME,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "softLocked" BOOLEAN NOT NULL DEFAULT false,
    "hardLocked" BOOLEAN NOT NULL DEFAULT false,
    "hardLockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT,
    "providerGroupId" TEXT,
    CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "User_providerGroupId_fkey" FOREIGN KEY ("providerGroupId") REFERENCES "ProviderGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("active", "createdAt", "customerId", "deletedAt", "email", "id", "mustChangePassword", "name", "passwordChangedAt", "providerGroupId", "twoFactorEnabled", "twoFactorSecret", "updatedAt", "username") SELECT "active", "createdAt", "customerId", "deletedAt", "email", "id", "mustChangePassword", "name", "passwordChangedAt", "providerGroupId", "twoFactorEnabled", "twoFactorSecret", "updatedAt", "username" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE INDEX "User_customerId_idx" ON "User"("customerId");
CREATE INDEX "User_providerGroupId_idx" ON "User"("providerGroupId");
CREATE INDEX "User_deletedAt_idx" ON "User"("deletedAt");
CREATE INDEX "User_hardLocked_idx" ON "User"("hardLocked");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
