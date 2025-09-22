# Audit Logging Architecture

> Tamper‑evident, append‑only, multi‑tenant, PHI‑guarded event ledger.

## Goals

| Goal | Explanation |
|------|-------------|
| Append-only | Prevent UPDATE/DELETE so past events cannot be silently altered or removed. |
| Tamper-evident | Hash chain across each tenant (chainKey) makes mutation detectable. |
| Multi-tenant | Independent ordered sequences per `chainKey` (usually `customerId` or `global`). |
| Safe metadata | Strict size caps (2KB metadata / 4KB diff) & PHI heuristics. |
| Rich queries | Cursor pagination, flexible filters (actor, category, action, entity, time, text). |
| Operational verification | On-demand chain integrity checks + spot sampling. |
| Extensible | Add new actions/entities without schema churn. |

## Data Model

`AuditEvent` (excerpt)
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
metadata   TEXT NULL -- canonical JSON ≤2KB
diff       TEXT NULL -- canonical JSON ≤4KB
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
- `canonicalJson` sorts object keys recursively, keeps array order.
- `hashPrev` links each record to its predecessor inside a chain.

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

Patterns currently scanned (case-insensitive where applicable):
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

Route: `/admin/audit-logs` (legacy `/admin/audit-events` now redirects) provides:
- Filter bar (text, actor, customer, category, action, entity, status, date range, limit)
- Cursor pagination (Load More)
- Expandable metadata/diff JSON
- Status coloring & chainKey visibility
- Columns are toggleable and persisted locally (`localStorage.auditCols`). Default set now includes: Time, Customer, Actor, Category, Action, Entity, Status, Summary/Message, Chain, Raw.
- Timezone: All timestamps are rendered in EST (America/New_York) regardless of client browser locale for consistent operational review. Hover title clarifies timezone. Future enhancement may add a toggle for local time.

### Maintenance UI

Route: `/admin/audit-maintenance` provides manual operational controls:
- Chain verification for a specific `chainKey`
- Sample verification across all chains
- Dry-run and execution of archive batches (copies to `AuditEventArchive` then deletes originals)
- Quick visibility into top chains by event volume

## Testing Overview

Location: `tests/audit/`
| File | Focus |
|------|-------|
| `hash.test.ts` | Canonical JSON & hash linkage |
| `payload-validation.test.ts` | Size limits & PHI detection |
| `chain-continuity.test.ts` | Tamper detection & integrity |
| `integration.test.ts` | Append-only triggers, concurrency, pagination |

## Extension Guidelines

| Task | Approach |
|------|----------|
| New action | Add string constant (VERB_OBJECT style) where invoked; no schema change required. |
| New category | Prefer reusing existing; add only if cross-cutting semantic grouping is necessary. |
| Larger metadata | Move bulky fields elsewhere; store references (IDs). |
| PHI exception | Explicitly pass `allowPhi: true` and document justification. |

## Operational Runbook

| Scenario | Action |
|----------|--------|
| Daily integrity check | Run `verifyAllChains()`; alert if any `.valid === false`. |
| Forensic anomaly | Export affected chain segment (`getChainSegment`) + store immutable copy. |
| Archival (future) | Move old rows to `AuditEventArchive` via scheduled job. |
| Volume spike | Investigate actor / action distribution via filtered search. |

## Threat Model Summary

| Threat | Mitigation |
|--------|------------|
| Silent row modification | Hash chain mismatch (hashSelf recomputation fails). |
| Row deletion | `seq` gap + missing predecessor hash reference; triggers during verification. |
| Off-platform mutation attempt | Triggers + verification jobs surface anomaly. |
| PHI leakage in logs | Heuristics block unless explicitly overridden. |
| Log flooding / DOS | Rate-limit at service layer (future) + volume monitoring. |

## Roadmap

- Archive job + manifest (e.g. monthly partition export)
- Background integrity sampler & metrics
- UI: per-row verify button & integrity badge
- Real-time tail (SSE/websocket)
- Enhanced diff helpers (auto field change summarizer)
- Expand PHI detection (names, addresses) behind opt-in

## Quick Reference

| Need | Use |
|------|-----|
| Log event | `audit.category({...})` |
| Paginate | `searchAuditEvents(filters, { limit, cursor })` |
| Request correlation | Filter on `requestId` / `traceId` |
| Verify chain | `verifyChain({ chainKey })` |
| Spot-check all chains | `verifyAllChains()` |
| Export segment | `getChainSegment(chainKey, fromSeq, toSeq)` |

## Glossary

| Term | Meaning |
|------|---------|
| chainKey | Partition identifier (tenant or global) for independent hash chain |
| seq | Monotonic integer index inside a chainKey |
| hashPrev | Hash of previous event in chain (null for first) |
| hashSelf | Current event's deterministic hash |
| PHI | Protected Health Information (regulated data) |

---

For questions or improvements, open an issue or PR referencing this file.

---

## Migration & Legacy Status (Cutover Complete)

As of current development (branch `logs` on 2025-09-21):

| Item | Status |
|------|--------|
| Legacy table `AuditLog` | Removed from schema (dropped via migration) |
| New table `AuditEvent` | Authoritative source |
| UI `/admin/audit-logs` | Reads `AuditEvent` only |
| Legacy writer helpers | Temporary shim (`app/utils/audit.server.ts`) still present (scheduled for deletion) |
| Direct `prisma.auditLog.create` usage | Removed |
| Follow-up | Delete shim after one more grep & test pass |

### Dropping the Legacy Table (Completed)

The `AuditLog` model has been removed from `prisma/schema.prisma`. To finalize locally:

1. Generate migration (if not already generated locally): `npx prisma migrate dev -n drop_auditlog_table`.
2. Commit the generated migration folder.
3. Run `npx prisma generate` to ensure client updates cleanly.
4. Remove the temporary shim file (`app/utils/audit.server.ts`) after a final grep shows no references to legacy exports.

### Why Keep the Shim Briefly?
It ensures any overlooked legacy call sites fail-safe into the new append-only system instead of throwing at runtime. After a full repo grep confirms no imports, delete the shim.

### Action Vocabulary Standardization
Some admin/provider actions still use ad-hoc names (e.g. `ADMIN_FETCH_PCG_PROVIDERS`). Consider mapping them into the curated enum set for consistency and cleaner filtering.

### Verification Checklist (Post-Removal)
- [x] `grep -R "auditLog"` returns no matches (other than historical migrations & this doc).
- [x] Migration generated & committed (historical migrations referencing AuditLog retained for history).
- [x] `prisma generate` succeeds.
- [x] Audit tests (`npm test --silent --filter=audit`) green.
- [x] Manual smoke: provider/admin actions appear in `/admin/audit-logs`.
- [x] Shim deleted.

---

## Export UI (Temporarily Deferred)

The previous Audit Logs UI included inline export buttons (CSV/JSON, page & full). These were removed temporarily due to inconsistent behavior in the dev environment (HTML document responses instead of attachment downloads) while underlying server routing was being stabilized.

Current state:
- Server export route still available at: `GET /admin/audit-logs/export?format=csv|json|csv-full|json-full` with existing filters as query params (search, action, category, etc.).
- Response headers: `Content-Disposition: attachment; filename="audit-logs-<timestamp>[ -full].(csv|json)"`, plus diagnostic `X-Audit-Export: 1` header.
- UI controls removed from `app/routes/admin+/audit-logs.tsx` (search for the comment `Export UI temporarily removed`).
- Added Customer column (Sept 22 2025): loader performs single batched `customer` lookup for distinct `customerId` values in the current page of events, avoiding N+1 queries and exposing both customer name and ID (copy shortcut) for each row.

Re‑enable plan (future):
1. Reintroduce a single primary "Export CSV" button (page scope only) using a plain anchor link with `download` attribute.
2. Add a dropdown or secondary action for "Full" export once large export performance validated.
3. (Optional) Introduce background job + emailed link for exports >5000 rows.
4. Log an audit event (`ADMIN_EXPORT_AUDIT_LOGS`) for each export trigger.

Troubleshooting notes (historic):
- Original issue surfaced when a resource route filename pattern prevented correct mounting; Remix served the layout HTML causing the client to flag an unexpected HTML response.
- Switching to a flat dot route (`audit-logs.export.ts`) and using anchor navigation minimized complexity.
- Remaining intermittent cases likely tied to auth/session cookie context during fetch; deferring until higher priority items complete.

To test server route manually now:
```
curl -I "http://localhost:3000/admin/audit-logs/export?format=csv&take=10" --cookie "<dev-session-cookie>"
```
Expect `200`, `Content-Type: text/csv`, and `X-Audit-Export: 1`.

---
