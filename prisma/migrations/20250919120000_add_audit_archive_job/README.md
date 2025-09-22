# Audit Archive Scaffold Migration

Creates (if needed) future scheduling artifacts. (No schema changes required; `AuditEventArchive` table already present.)

This placeholder migration documents intent only. If future columns / indexes are required for archival cursoring (e.g. composite on `(chainKey, seq)`), add them in a follow-up migration.
