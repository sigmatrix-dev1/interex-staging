-- Add unique constraint on (chainKey, seq) to support optimistic concurrency for audit inserts.
-- This allows us to drop the explicit transaction tail-read lock contention pattern.

PRAGMA foreign_keys=OFF;

-- Create a temporary index if not exists (Prisma will manage schema drift detection on generate)
CREATE UNIQUE INDEX IF NOT EXISTS AuditEvent_chain_seq_unique ON AuditEvent(chainKey, seq);

PRAGMA foreign_keys=ON;
