-- Create Enums (SQLite uses CHECK constraints; documented for future Postgres move)
-- For Prisma, we define enums in schema.prisma later if we want client typing.

-- Main audit event table
CREATE TABLE IF NOT EXISTS "AuditEvent" (
  "id" TEXT PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- chain & integrity
  "chainKey" TEXT NOT NULL, -- per-tenant (customerId) or 'global'
  "seq" INTEGER NOT NULL,   -- monotonically increasing within chainKey
  "hashPrev" TEXT,
  "hashSelf" TEXT NOT NULL,
  -- actor
  "actorType" TEXT NOT NULL, -- USER | SYSTEM | SERVICE
  "actorId" TEXT,
  "actorDisplay" TEXT,
  "actorIp" TEXT,
  "actorUserAgent" TEXT,
  -- scope
  "customerId" TEXT,
  -- classification
  "category" TEXT NOT NULL, -- AUTH | SUBMISSION | DOCUMENT | USER_ROLE | TENANT_CFG | INTEGRATION | SECURITY | ADMIN | SYSTEM | ERROR
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SUCCESS', -- SUCCESS | FAILURE | INFO | WARNING
  -- target entity (optional)
  "entityType" TEXT,
  "entityId" TEXT,
  -- correlation
  "requestId" TEXT,
  "traceId" TEXT,
  "spanId" TEXT,
  -- descriptive
  "summary" TEXT,         -- short human summary (<200 chars)
  "message" TEXT,         -- optional longer message (<1000 chars)
  -- structured metadata (small)
  "metadata" TEXT,        -- canonical JSON ( <= 2KB )
  "diff" TEXT,            -- optional canonical JSON diff snapshot ( <= 4KB )
  -- compliance flags
  "phi" BOOLEAN NOT NULL DEFAULT 0,    -- whether metadata/diff contain PHI (should normally be 0)
  -- reserved
  "reserved1" TEXT,
  "reserved2" TEXT,
  -- foreign keys (soft currently, not enforced to keep lightweight)
  CONSTRAINT "ck_auditevent_seq_positive" CHECK (seq > 0)
);

-- Archive table (structure mirror, fewer indexes, no triggers yet)
CREATE TABLE IF NOT EXISTS "AuditEventArchive" (
  "id" TEXT PRIMARY KEY,
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
  "phi" BOOLEAN NOT NULL DEFAULT 0,
  "reserved1" TEXT,
  "reserved2" TEXT,
  CONSTRAINT "ck_auditeventarchive_seq_positive" CHECK (seq > 0)
);

-- Indexes for primary table
CREATE INDEX IF NOT EXISTS "idx_auditevent_chain_seq" ON "AuditEvent"("chainKey","seq");
CREATE INDEX IF NOT EXISTS "idx_auditevent_createdAt" ON "AuditEvent"("createdAt");
CREATE INDEX IF NOT EXISTS "idx_auditevent_category_createdAt" ON "AuditEvent"("category","createdAt");
CREATE INDEX IF NOT EXISTS "idx_auditevent_actor_createdAt" ON "AuditEvent"("actorId","createdAt");
CREATE INDEX IF NOT EXISTS "idx_auditevent_customer_createdAt" ON "AuditEvent"("customerId","createdAt");
CREATE INDEX IF NOT EXISTS "idx_auditevent_request_createdAt" ON "AuditEvent"("requestId","createdAt");
CREATE INDEX IF NOT EXISTS "idx_auditevent_entity" ON "AuditEvent"("entityType","entityId");

-- Append-only: prevent UPDATE & DELETE
CREATE TRIGGER IF NOT EXISTS "trg_auditevent_no_update" BEFORE UPDATE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent is append-only (no UPDATE)');
END;

CREATE TRIGGER IF NOT EXISTS "trg_auditevent_no_delete" BEFORE DELETE ON "AuditEvent"
BEGIN
  SELECT RAISE(ABORT, 'AuditEvent is append-only (no DELETE)');
END;

-- Simplified trigger: only validate hashPrev integrity. (Seq is assigned in application layer.)
CREATE TRIGGER IF NOT EXISTS "trg_auditevent_validate_chain" BEFORE INSERT ON "AuditEvent"
BEGIN
  SELECT CASE
    WHEN NEW.seq = 1 AND NEW.hashPrev IS NULL THEN NULL
    WHEN NEW.seq = 1 AND NEW.hashPrev IS NOT NULL THEN RAISE(ABORT, 'First event must have NULL hashPrev')
    WHEN NEW.seq > 1 THEN (
      SELECT CASE
        WHEN (SELECT hashSelf FROM AuditEvent WHERE chainKey = NEW.chainKey AND seq = NEW.seq - 1) = NEW.hashPrev THEN NULL
        ELSE RAISE(ABORT, 'hashPrev mismatch for chain')
      END
    )
  END;
END;
