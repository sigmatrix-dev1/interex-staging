-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "purposeOfSubmission" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "claimId" TEXT,
    "caseId" TEXT,
    "comments" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "authorType" TEXT NOT NULL DEFAULT 'Individual',
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

-- CreateTable
CREATE TABLE "SubmissionDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "fileName" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'English',
    "documentType" TEXT NOT NULL DEFAULT 'PDF',
    "attachmentControlNumber" TEXT,
    "comments" TEXT,
    "fhirResourceId" TEXT,
    "uploadStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "submissionId" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    CONSTRAINT "SubmissionDocument_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SubmissionDocument_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Submission_creatorId_idx" ON "Submission"("creatorId");

-- CreateIndex
CREATE INDEX "Submission_providerId_idx" ON "Submission"("providerId");

-- CreateIndex
CREATE INDEX "Submission_customerId_idx" ON "Submission"("customerId");

-- CreateIndex
CREATE INDEX "Submission_status_idx" ON "Submission"("status");

-- CreateIndex
CREATE INDEX "Submission_purposeOfSubmission_idx" ON "Submission"("purposeOfSubmission");

-- CreateIndex
CREATE INDEX "SubmissionDocument_submissionId_idx" ON "SubmissionDocument"("submissionId");

-- CreateIndex
CREATE INDEX "SubmissionDocument_uploaderId_idx" ON "SubmissionDocument"("uploaderId");
