# 20250919_add_audit_event

Introduce normalized append-only audit logging infrastructure.

## New Enums
- AuditCategory
- AuditActorType
- AuditStatus

## New Tables
- AuditEvent (primary append-only chain)
- AuditEventArchive (future use; same shape minus some indexes)

## Notes
- We retain existing `AuditLog` / `SecurityEvent` / `AppLog` for now; future migrations may consolidate.
- Hash chain uses (tenant/customer scoped) `chainKey = customerId || '::global'` + incremental monotonic ordering by `createdAt` + surrogate `seq`.
- `hashPrev` references previous row's `hashSelf` within same chainKey sequence.
- Insert trigger will compute `seq` and enforce append-only semantics.
- Update/Delete triggers raise abort.

## Rollback Strategy
Dropping the tables & enums is safe since no other objects depend on them yet.
