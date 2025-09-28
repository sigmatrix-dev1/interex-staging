# Audit Logging Architecture

> Tamper-evident, append-only, multi-tenant, PHI-guarded event ledger.

## Goals

| Goal | Explanation |
|------|-------------|
| Append-only | Prevent UPDATE/DELETE so past events cannot be silently altered or removed. |
| Tamper-evident | Hash chain across each tenant (chainKey) makes mutation detectable. |
| Multi-tenant | Independent ordered sequences per `chainKey` (usually `customerId` or `global`). |
| Safe metadata | Strict size caps (2KB metadata / 4KB diff) and PHI heuristics. |
| Rich queries | Cursor pagination, flexible filters (actor, category, action, entity, time, text). |
| Operational verification | On-demand chain integrity checks plus spot sampling. |
| Extensible | Add new actions/entities without schema churn. |

## Data Model

AuditEvent (excerpt)
```
chainKey  TEXT      -- partition key per tenant or global scope
seq       INTEGER   -- 1-based contiguous sequence inside chainKey
hashPrev  TEXT NULL -- previous hashSelf (null for first)
hashSelf  TEXT      -- sha256(canonical core fields + hashPrev)
category  TEXT      -- e.g. SUBMISSION, AUTH, DOCUMENT
action    TEXT      -- e.g. SUBMISSION_CREATE
status    TEXT      -- SUCCESS | FAILURE | INFO | WARNING
actorType TEXT      -- USER | SYSTEM | SERVICE
actorId   TEXT NULL
entityType TEXT NULL
entityId   TEXT NULL
requestId  TEXT NULL
traceId    TEXT NULL
spanId     TEXT NULL
summary    TEXT NULL
message    TEXT NULL
metadata   TEXT NULL -- canonical JSON <=2KB
diff       TEXT NULL -- canonical JSON <=4KB
phi        BOOLEAN   -- heuristics flagged potential PHI
createdAt  DATETIME  -- insertion time
```

### Hash Payload Definition
```ts
hashSelf = sha256Hex(canonicalJson({
  v: 1,
  chainKey, seq, category, action, status,
  actorType, actorId, entityType, entityId,
  summary, metadata, diff, hashPrev
}))
```
- canonicalJson sorts object keys recursively and keeps array order.
- hashPrev links each record to its predecessor inside a chain.

## Writing Events

Use category helpers from `app/services/audit.server.ts`:
```ts
import { audit } from '#app/services/audit.server.ts'

await audit.submission({
  action: 'SUBMISSION_CREATE',
  actorType: 'USER',
  actorId: user.id,
  customerId: submission.customerId,
  entityType: 'SUBMISSION',
  entityId: submission.id,
  summary: 'Submission created',
  metadata: { providerId: submission.providerId },
})
```

Allow PHI only when necessary:
```ts
await audit.system({
  action: 'BATCH_IMPORT',
  actorType: 'SYSTEM',
  allowPhi: true,
  metadata: { patientDob: '1980-04-01' },
})
```
If `allowPhi` is omitted and PHI heuristics match (SSN, MRN, DOB patterns), the call throws.

## Querying

Helpers in `app/services/audit-query.server.ts`:
```ts
const recent = await getRecentSubmissionAuditEvents(customerId, { limit: 25 })

const search = await searchAuditEvents({
  actorId: 'user_123',
  category: 'AUTH',
  text: 'login',
  from: new Date(Date.now() - 3600_000),
}, { limit: 50 })
```
Pagination uses stable order `(createdAt DESC, id DESC)` with cursor `{ createdAt, id }`.

## Chain Verification

`app/services/audit-verify.server.ts`:
```ts
const res = await verifyChain({ chainKey: customerId })
if (!res.valid) console.error(res.mismatches)

const all = await verifyAllChains() // spot-check sampled rows per chain
```
Return shape:
```ts
{
  chainKey,
  fromSeq, toSeq,
  checked, valid,
  mismatches: [{ seq, id, reason, expectedHashSelf, actualHashSelf }]
}
```

## PHI Heuristics

Patterns scanned (case-insensitive where applicable):
- SSN: `\b\d{3}-\d{2}-\d{4}\b`
- MRN token: `\bMRN[:#]?\s*\d{5,}\b`
- Date-of-birth style: `YYYY-MM-DD` (basic) variants

Extend in `audit-hash.ts` (`phiPatterns`). Keep conservative; false positives are safer.

## Size Enforcement

| Field | Limit | Behavior |
|-------|-------|----------|
| metadata | 2048 bytes | Throws if exceeded |
| diff | 4096 bytes | Throws if exceeded |

Use succinct structured JSON. Reference large entities by ID.

## Concurrency & Busy Retries

Insertion uses a short exponential backoff (default 4 attempts, 25ms base) when encountering `SQLITE_BUSY` (LiteFS sync or concurrent writers). Sequence number allocation is performed inside a transaction to avoid gaps.

## Admin UI

Route: `/admin/audit-logs` provides:
- Filter bar (text, actor, customer, category, action, entity, status, date range, limit)
- Cursor pagination (Load More)
- Expandable metadata/diff JSON
- Status coloring and chainKey visibility
- Columns are toggleable and persisted locally
- Timestamps rendered in EST for consistent operational review

## Migration & Legacy Status

- Legacy `AuditLog` model removed; `AuditEvent` is authoritative.
- Export UI is temporarily deferred; server export route remains available.

## Runbook

| Scenario | Action |
|----------|--------|
| Integrity check | Run `verifyAllChains()`; alert on invalid. |
| Forensics | Export chain segment and store immutable copy. |
| Archival | Move old rows to `AuditEventArchive` via job. |