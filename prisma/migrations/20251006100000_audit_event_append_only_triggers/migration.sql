-- Enforce append-only semantics for AuditEvent via SQLite triggers.
-- UPDATEs or DELETEs should raise an error so tests expecting failures pass.

CREATE TRIGGER IF NOT EXISTS AuditEvent_no_update
BEFORE UPDATE ON AuditEvent
BEGIN
  SELECT RAISE(FAIL, 'UPDATE forbidden on AuditEvent (append-only)');
END;

CREATE TRIGGER IF NOT EXISTS AuditEvent_no_delete
BEFORE DELETE ON AuditEvent
BEGIN
  SELECT RAISE(FAIL, 'DELETE forbidden on AuditEvent (append-only)');
END;
