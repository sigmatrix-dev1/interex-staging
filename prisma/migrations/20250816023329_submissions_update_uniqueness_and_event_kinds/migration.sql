/*
  Warnings:

  - A unique constraint covering the columns `[pcgSubmissionId]` on the table `Submission` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Submission_pcgSubmissionId_key" ON "Submission"("pcgSubmissionId");
