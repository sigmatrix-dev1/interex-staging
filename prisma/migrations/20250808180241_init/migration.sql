/*
  Warnings:

  - You are about to drop the column `fhirSubmissionId` on the `Submission` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Submission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "purposeOfSubmission" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "claimId" TEXT,
    "caseId" TEXT,
    "comments" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "authorType" TEXT NOT NULL DEFAULT 'Individual',
    "autoSplit" BOOLEAN NOT NULL DEFAULT false,
    "category" TEXT NOT NULL DEFAULT 'DEFAULT',
    "sendInX12" BOOLEAN NOT NULL DEFAULT false,
    "threshold" INTEGER NOT NULL DEFAULT 100,
    "fhirAcknowledgment" TEXT,
    "transactionId" TEXT,
    "responseMessage" TEXT,
    "errorDescription" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "submittedAt" DATETIME,
    "creatorId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    CONSTRAINT "Submission_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Submission_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Submission_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Submission" ("authorType", "autoSplit", "caseId", "category", "claimId", "comments", "createdAt", "creatorId", "customerId", "errorDescription", "fhirAcknowledgment", "id", "providerId", "purposeOfSubmission", "recipient", "responseMessage", "sendInX12", "status", "submittedAt", "threshold", "title", "transactionId", "updatedAt") SELECT "authorType", "autoSplit", "caseId", "category", "claimId", "comments", "createdAt", "creatorId", "customerId", "errorDescription", "fhirAcknowledgment", "id", "providerId", "purposeOfSubmission", "recipient", "responseMessage", "sendInX12", "status", "submittedAt", "threshold", "title", "transactionId", "updatedAt" FROM "Submission";
DROP TABLE "Submission";
ALTER TABLE "new_Submission" RENAME TO "Submission";
CREATE INDEX "Submission_creatorId_idx" ON "Submission"("creatorId");
CREATE INDEX "Submission_providerId_idx" ON "Submission"("providerId");
CREATE INDEX "Submission_customerId_idx" ON "Submission"("customerId");
CREATE INDEX "Submission_status_idx" ON "Submission"("status");
CREATE INDEX "Submission_purposeOfSubmission_idx" ON "Submission"("purposeOfSubmission");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
