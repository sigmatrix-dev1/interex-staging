-- Add RecoveryCode model
CREATE TABLE "RecoveryCode" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "usedAt" DATETIME,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode" ("userId");
CREATE INDEX "RecoveryCode_userId_usedAt_idx" ON "RecoveryCode" ("userId", "usedAt");
