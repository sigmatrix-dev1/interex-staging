# InterEx System Specification (Single Source of Truth)

Last updated: 2025-10-06

Status: Phase 1 security hardening completed; this document supersedes and fully replaces the following removed legacy docs:

Superseded files (deleted):
- TECHNICAL_SPEC.md
- INTEREX_FULL_GUIDE.md
- 2FA-IMPLEMENTATION.md
- AUDIT_LOGGING.md
- PAGE_TABLES_GUARDRAILS.md
- TEST_CATALOG.md
- TEST_PLAN_MFA_RATE_LIMITING.md
- MIGRATION_NOTES.md
- INTEREX_CLIENT_USER_GUIDE.md

Retained separate roadmap file (do NOT duplicate details here):
- SECURITY_ENHANCEMENT_PHASES.md (authoritative phased roadmap)

Purpose: A single, exhaustive, engineer‑oriented reference covering product domain, architecture, schema, security controls, operational practices, testing strategy, and environment configuration. Non‑engineer readers can skim Product Overview, Roles & Flows, and Operational Runbook sections.

---
## Table of Contents
1. Product Overview & Domain Scope
2. Core Roles & Access Model (RBAC)
3. High-Level Architecture
4. Environment & Configuration (Flags + Secrets)
5. Modules & User Flows
   - 5.1 Authentication & MFA / Recovery
   - 5.2 Account Lockout & Rate Limiting
   - 5.3 CSRF Protection
   - 5.4 Submissions Lifecycle (PCG Integration)
   - 5.5 Providers, NPIs, Groups & eMDR
   - 5.6 Letters
   - 5.7 User & Role Administration
   - 5.8 Audit & Security Event Visibility
   - 5.9 Sessions & Active Session Management
6. Database Schema Overview & Key Constraints
7. Security Architecture & Controls Inventory
8. Audit Logging (Hash Chain) Architecture
9. Page Catalog (Tables, Columns, Actions, Guardrails)
10. Testing Strategy & Coverage Matrix
11. Migration & Data Evolution Summary
12. Operational Runbook (Deployment, Secrets, Maintenance)
13. Logging & Observability (Audit, Security, Provider, AppLog)
14. Risk Posture & Threat Mitigations (Current State)
15. Future / Deferred Items (Pointer to Roadmap)
16. Glossary
17. Change Log (Spec File)

---
## 1. Product Overview & Domain Scope
InterEx streamlines healthcare submissions (attachments & documentation) to CMS/PCG, manages provider NPIs & eMDR registrations, and centralizes regulatory letters. Application goals:
- Consistent, traceable submission lifecycle
- Role-scoped minimal access to PHI-bearing artifacts
- Strong default security posture (universal MFA, lockout, CSRF, tamper-evident audit)
- Operational transparency for administrators

Primary Domains:
- Authentication & Account Security
- Submissions (Create → Update → Upload → Status Sync)
- Provider / NPI / Group Management & eMDR registration
- Letters ingestion & viewing (pre-pay, post-pay, other)
- Audit & Security Events for forensics and compliance

---
## 2. Core Roles & Access Model (RBAC)
Roles (mutually combinable but typically single primary):
- system-admin: Global tenant & operations authority
- customer-admin: Manages users, groups, NPIs within own customer
- provider-group-admin: Manages users & NPIs within a single provider group
- basic-user: Access limited to assigned NPIs (submissions & letters)

RBAC Enforcement:
- Route loaders/actions perform `requireUserId` + role/tenant scoping.
- Visibility scoping for provider/eMDR & letters queries restricts dataset before rendering.
- Guardrails prevent destructive operations when dependencies exist (e.g., user deletion blocked if submissions or events exist; provider group delete blocked if users/providers present).

---
## 3. High-Level Architecture
Stack: Remix (React Router) + TypeScript + Node 22, Tailwind CSS, Zod + Conform forms, Prisma (SQLite/LiteFS in production), Vitest + Playwright.

Key Layers:
- Web UI (Remix routes under `app/routes/`)
- Service layer (`app/services/*`) wrapping external PCG APIs, audit, letters, provider/eMDR utilities
- Domain helpers & enums (`app/domain/*`)
- Persistence via Prisma (`prisma/schema.prisma` + migrations)
- Dev / prod entry: `server/index.ts` / build server script for deployment

External Integration:
- PCG HIH wrapper APIs (submissions, providers, eMDR, letters)

Observability Components:
- AuditEvent (hash-chained tamper-evident log)
- SecurityEvent (auth/security lifecycle)
- ProviderEvent (provider/eMDR business operations)
- AppLog (structured operational logging – minimal baseline, extensible)

---
## 4. Environment & Configuration (Flags + Secrets)
Baseline required secret:
- SESSION_SECRET (cookie/session signing)

Security & Auth Flags:
- AUTH_RATE_LIMIT_ENABLED (bool) – enables login/MFA/reset rate limiting
- AUTH_RATE_LIMIT_WINDOW_SEC (number, default 60)
- AUTH_RATE_LIMIT_MAX (number, default 10)
- LOCKOUT_ENABLED (bool) – enables account lockout logic
- LOCKOUT_THRESHOLD (failures before lock, default 10)
- LOCKOUT_WINDOW_SEC (rolling window seconds, default 600)
- LOCKOUT_BASE_COOLDOWN_SEC (starting lock duration seconds, default 300)
- CSRF_MODE (off|log|enforce) – runtime enforcement mode; tests force enforce
- TOTP_ENC_KEY / MFA_ENCRYPTION_KEY (32-byte base key for AES-256-GCM encryption of TOTP secrets)
- RECOVERY_CODES_COUNT (integer, default 10)

Logging / Privacy:
- LOG_IP_MODE (raw|masked|hash)
- IP_HASH_SALT (required if LOG_IP_MODE=hash)

PCG Integration:
- PCGF_CLIENT_ID / PCGF_CLIENT_SECRET
- PCGF_TOKEN_URL / PCGF_API_BASE

Optional:
- SENTRY_DSN / SENTRY_ENVIRONMENT
- AWS_* + BUCKET_NAME (if object storage introduced later)

Removed / Obsolete Flags:
- PRIVILEGED_2FA_WARN, PRIVILEGED_2FA_ENFORCE, REQUIRE_2FA_ON_LOGIN (superseded by universal MFA baseline)
- PASSKEY_* (passkey feature removed)

---
## 5. Modules & User Flows
### 5.1 Authentication & MFA / Recovery
Features:
1. Universal mandatory TOTP MFA: credential verification establishes a provisional (uncommitted) context until OTP success.
2. Encrypted secret storage: secrets encrypted at rest with AES-256-GCM (key from TOTP_ENC_KEY / MFA_ENCRYPTION_KEY).
3. Recovery Codes (privileged roles only: system-admin & customer-admin) – single-use, hashed, audited.
4. Admin self MFA reset (two-phase): verify old code → rotate secret → verify new.
5. Password lifecycle (complexity, breach check with timeout fail-open, forced change gate).
6. Session invalidation on manual password reset & logout-others option post-login.

Primary Routes/Files:
- `_auth+/login.tsx`, `_auth+/2fa.tsx`, `_auth+/2fa-setup.tsx`, `_auth+/logout.tsx`
- `me.2fa.tsx` (user self-management)
- Recovery codes UI (privileged) integrated into 2FA settings route.
Auditing & Events:
- Audit: `MFA_SETUP_START`, `MFA_ENABLE`, `MFA_VERIFY`, `MFA_VERIFY_FAILED`, `MFA_RESET`, `LOGOUT_OTHERS_ON_LOGIN`
- SecurityEvent: password reset link & manual resets, login failures, MFA failures

### 5.2 Account Lockout & Rate Limiting
Rate Limiting:
- IP-scoped counters on public auth endpoints (login, MFA verify, reset); emits `LOGIN_RATE_LIMIT_BLOCK` SecurityEvent (naming approximate – see code) when enforced.
Lockout:
- Failure count increments within rolling window; reaching threshold locks account until `lockedUntil` (adaptive: base cooldown + potential increment logic). Manual unlock via admin path or natural expiry.
- Audit: `AUTH_LOCKOUT_TRIGGERED`, `AUTH_LOCKOUT_CLEARED`.

### 5.3 CSRF Protection
Mechanism: Double-submit token (session-stored nonce + hidden form field). All mutating POST forms include `<CsrfInput />`.
Modes: `off` (no check), `log` (warn-only), `enforce` (403). Tests hard-force enforcement to guarantee negative path determinism.

### 5.4 Submissions Lifecycle
Steps:
1. Draft Creation (metadata + planned documents)
2. Metadata Review/Update (server refresh PCG snapshot)
3. File Upload & Finalization
Events (Audit / SubmissionEvent): `DRAFT_CREATED`, `META_UPDATED`, `PCG_CREATE_*`, `PCG_UPDATE_*`, `PCG_STATUS`, `STATUS_UPDATED`.
Guardrails: Draft-only edit; recipient & purpose validation; file type/size & count enforcement; RBAC scope on provider/NPI.

### 5.5 Providers, NPIs, Groups & eMDR
Provider Group CRUD with delete guardrails (no users/providers). Provider NPI management: create/update, group alignment banner, active toggle, user assignments with alignment constraints. eMDR registration flows (register, deregister, set electronic-only) require full provider identity data.
Events: ProviderEvent (CREATED, UPDATED, ACTIVATED, GROUP_ASSIGNED, PCG_ADD_*), Audit events for each administrative attempt & outcome.

### 5.6 Letters
Types: Prepay, Postpay, PostpayOther.
Features: Sync by type & date range; first-view stamping; ET timezone normalization; PDF view; due date highlighting.
PHI Minimization: Only essential fields in audit metadata; raw payload retained DB-side.

### 5.7 User & Role Administration
System Admin: Full cross-customer management; creation with generated strong password (mustChangePassword flag set). Customer Admin: limited to own tenant; group-admin narrower still.
Actions: Create/Update, Manual & Link Reset, Assign NPIs, Activate/Deactivate, Delete (guarded), 2FA reset (admin logic), Recovery codes issuance (privileged only).

### 5.8 Audit & Security Event Visibility
Admin UI (`/admin/audit-logs`): filter, pagination, JSON expanders, EST timestamps, chain verification maintenance actions separate page.

### 5.9 Sessions & Active Session Management
Per-user session listing (device fingerprint summary, IP (mode-processed), first/last active, revoke individual, sign out others). MFA enforcement ensures full session only after OTP verification. Optional multi-session revocation triggers audit record.

---
## 6. Database Schema Overview & Key Constraints
Core (Identity): User (failedLoginCount, lockedUntil, twoFactorSecret (encrypted blob), twoFactorEnabled, mustChangePassword), Password, Session, Verification, Role, Permission, TwoFactorRecoveryCode.
Tenant & Provider Domain: Customer, ProviderGroup (unique (customerId,name)), Provider (unique npi), UserNpi (unique (userId, providerId)).
Submissions: Submission, SubmissionDocument, SubmissionEvent.
Letters: PrepayLetter, PostpayLetter, PostpayOtherLetter.
eMDR Snapshots: ProviderListDetail, ProviderRegistrationStatus.
Logging: AuditEvent, AuditEventArchive, ProviderEvent, SecurityEvent, AppLog (optional).
Indexes emphasize frequent filters: customerId, providerGroupId, providerId, createdAt, letterDate, status.
All Phase 1 migrations additive (no destructive changes executed yet).

---
## 7. Security Architecture & Controls Inventory
Control | Implementation | Notes
--------|----------------|------
Strong Password Policy | Zod + helper; complexity & breach check (timeout fail-open) | Force-change gate
Universal MFA | TOTP via @epic-web/totp (encrypted secrets) | Mandatory for all users
Recovery Codes | Hashed single-use codes (privileged issuance) | Audited generate/use
Account Lockout | Rolling failure window + cooldown | Flag gated
Auth Rate Limiting | Middleware (in-memory counters) | Env-configurable
CSRF Protection | Session nonce + hidden token | Tests always enforce
Tamper-Evident Audit | Hash-chained per chainKey | PHI heuristics & size caps
Security Events | Structured table for auth anomalies | Input to future anomaly detection
Least Privilege RBAC | Route & query scoping | Guardrails for destructive ops
PHI Minimization | Sanitized audit metadata | Raw letter payload retained DB only
Session Hygiene | Logout others, active session revoke | Future trusted session flag (Phase 2+)
Encryption (MFA Secrets) | AES-256-GCM with master key | Idempotent migration script
Honeypot & Validation | Login/Forms anti-bot & Zod validation | Reduces noise
Content Security Policy | Enforced strict CSP header (default-src 'self', no remote scripts) | Inline styles allowed for Tailwind; adjust if new CDNs added

---
## 8. Audit Logging (Hash Chain) Architecture
Design Goals: Append-only, per-tenant chain integrity, PHI-guarded metadata, rich querying, verifiable exports.
Hash Construction: sha256(canonicalJson(v1 core fields + prev hash)).
Integrity Ops: `verifyChain(chainKey)` & `verifyAllChains()` (spot sampling). Archive path moves old rows to AuditEventArchive (future Phase 2 job).
Field Limits: metadata ≤ 2KB, diff ≤ 4KB (throws if exceeded). PHI heuristics: SSN, MRN token, DOB patterns – blocked unless `allowPhi`.
Concurrency: Busy retry with small exponential backoff to avoid sequence gaps under SQLite/LiteFS contention.

---
## 9. Page Catalog (Tables, Columns, Actions, Guardrails)
Summarized representatives below (full detail previously fragmented—now condensed). For exhaustive column/action lists, reference source routes; maintain changes here when altering column sets or guardrails.

Area | Route | Key Columns (Representative) | Core Actions | Guardrails
-----|-------|------------------------------|--------------|-----------
Admin Customers | /admin/customers | Name, BAA, Admins, Active, Created | Add Customer/Admin | system-admin only, back guard
Admin Users | /admin/users | Name, Email, Roles, 2FA, NPIs, Status | Create, Reset (link/manual/2FA), Activate/Deactivate | system-admin only, deletion safeguards
Customer Users | /customer/users | Name, Roles, Group, NPIs, Status | Edit, Assign NPIs, Reset, Toggle | Scoped by role & group, self-toggle blocked
Provider NPIs | /customer/provider-npis | NPI, Name, Group, Assigned User, Status | Assign Users, Edit, Toggle Active, Group Change | Alignment constraints, eligibility gating
Provider Groups | /admin/customer-manage/:id/provider-groups | Name, Users, NPIs, Active | Create, Edit, Delete | Delete blocked if dependents
Audit Logs | /admin/audit-logs | Time, Customer, Actor, Category, Action, Status | Filter, (Export future) | system-admin only
All Letters | /admin/all-letters | Letter ID, NPI, Provider, Customer, Group, Dates, Days Left | Sync, View PDF | system-admin only, PHI-min metadata
Submissions | /customer/submissions | Title, NPI, Purpose, Status, Created/Updated | New, Continue, Retry | Draft-only edits, RBAC scope
Providers eMDR | /providers-emdr | NPI, Reg Status, Electronic Only, Address | Fetch, Update, Register/Deregister, Set Electronic Only | Data prerequisites, confirmation gating
My NPIs | /my-npis | NPI, Provider, Group, Status | (View) | User assignments only

Global Guardrails Summary:
- Delete operations blocked when dependent records exist (counts surfaced to UI)
- Group alignment rules enforce consistent provider → user group relationships
- 2FA & lockout gating precede protected route access

---
## 10. Testing Strategy & Coverage Matrix
Layers:
- Unit (helpers, hashing, password lifecycle)
- Integration (route actions, audit chain continuity)
- E2E (Playwright: auth flows, MFA enforcement, provider guardrails, letters, error boundaries)

Security-Focused Suites:
- MFA enforcement & negative code paths
- CSRF positive & negative (direct action invocation)
- Recovery codes (privileged issuance & consumption + unauthorized attempt)
- Lockout logic (failure accumulation, lock state, unlock path)

Coverage Matrix (Representative):
Area | Coverage | Status
-----|----------|-------
MFA Setup/Verify | E2E + unit verification helpers | ✅
MFA Invalid / Enforcement Redirect | E2E | ✅
Recovery Codes | Security tests | ✅
Lockout | Security test + integration | ✅
CSRF | Positive/Negative tests | ✅ (enforced in test env)
Password Policy & Breach Check | Unit + integration | ✅
Audit Hash Chain | Unit + integration | ✅
Rate Limiting | E2E (enabled flag) | ✅
Letters & Providers Guardrails | E2E | ✅
Passkeys | Out of scope (removed) | —

Gaps / Planned (Track in Roadmap Phase 2+):
- Admin MFA self-reset detailed test phase coverage
- Session logout-others explicit isolated test
- Automated anomaly detection triggers (future feature)

Testing Principles:
1. Every security control: success + failure + regression scenario.
2. Direct action invocation for negative paths to avoid network flakiness (e.g., CSRF).
3. Prefer custom matchers for cookie/session assertions (keeps test intent high-level).

---
## 11. Migration & Data Evolution Summary
Phase 0: No schema changes.
Phase 1 (Completed): Added `failedLoginCount`, `lockedUntil`, `TwoFactorRecoveryCode` table; encrypted TOTP migration script (idempotent); all additive.
Deferred Destructive Cleanup: Legacy provider connection/ OAuth tables (not yet dropped – require explicit approval) & passkey model (currently stub/inactive; safe to drop later).
Encryption Backfill: Script encrypts plaintext secrets if not already in encrypted format (detectable by prefix/tag shape) – safe re-run.

---
## 12. Operational Runbook (Deployment, Secrets, Maintenance)
Setup:
1. Copy `.env.example` → `.env`; set SESSION_SECRET & PCG credentials.
2. `npm install` → `npm run setup` (migrate + generate + Playwright install).
3. Dev: `npm run dev`; Prod build: `npm run build` + `npm start` after `prisma migrate deploy`.

Deployment (Fly.io):
- Uses Dockerfile + LiteFS for replicated SQLite. Ensure migrations executed before traffic shift.
- Monitor logs for audit insertion errors & rate-limit anomalies after release.

Maintenance Tasks:
- Audit Chain Verification: run manual `verifyAllChains()` after major releases; schedule background job (Phase 2 enhancement).
- Secret Rotation: rotate SESSION_SECRET & TOTP_ENC_KEY with rolling deploy (old sessions invalidated if session secret changed).
- Recovery Codes: Encourage privileged users to regenerate after secret rotation if procedural.
- CSRF Mode Escalation: Observe log-only metrics for token presence (≥ 7 days) → flip to `enforce`.

Backout Procedures:
- Lockout / Rate limiter: toggle env flags off.
- CSRF emergency: set `CSRF_MODE=off` temporarily (investigate root cause promptly).
- MFA: universal enforcement design – rollback would require code change (deliberately no flag to avoid policy drift).

---
## 13. Logging & Observability
Channel | Use | Retention Strategy (Planned)
--------|-----|-----------------------------
AuditEvent | Compliance & forensics | Archive >180d (Phase 2 job)
SecurityEvent | Auth anomaly & reset tracking | Roll to archive or purge beyond 90d (future)
ProviderEvent | Business ops trace | Similar to SecurityEvent
AppLog | Operational diagnostics | Configurable sink (future SIEM streaming)

Integrity & Tamper Detection: hash chain verification + mismatch alerting (future job) feeding AppLog & system audit event.

---
## 14. Risk Posture & Threat Mitigations (Current)
Threat | Mitigation | Residual Risk
-------|------------|--------------
Credential Stuffing | Universal MFA + rate limiting + lockout | Targeted phishing remains (user-level)
Session Theft (Cookie) | HttpOnly, secure (prod), MFA gating, logout-others | Need CSRF enforce prod flip
Brute Force Password | Rate limiting + lockout + MFA | Distributed low-velocity attempts across many IPs
CSRF | Double-submit (pending full prod enforce) | Enforce flag not yet flipped
Audit Tampering | Hash chain + (soon) scheduled verify | Offline DB tamper pre-verification window
PHI Exposure via Logs | PHI heuristics & blocked writes | False negatives for novel patterns
Password Reuse / Breach | Complexity + breach API (timeout fail-open) | Offline rainbow reuse inside allowed window

---
## 15. Future / Deferred Items
See `SECURITY_ENHANCEMENT_PHASES.md` for authoritative roadmap (Phase 2+). This spec intentionally omits deep future design details to avoid duplication drift.

---
## 16. Glossary
PCG – Palmetto GBA (CMS HIH Wrapper)
eMDR – Electronic Medical Documentation Request
NPI – National Provider Identifier
RBAC – Role-Based Access Control
PHI – Protected Health Information
ADR – Additional Documentation Request
OID – Object Identifier (recipient directory)
ACN – Attachment Control Number (submission document)

---
## 17. Change Log (Spec File)
2025-10-06: Initial consolidated SSoT created (Phase 1 completion). Replaced multiple legacy docs; updated security posture (lockout, CSRF infra, secret encryption, recovery codes, passkey removal, CSP enforcement).

---
End of InterEx System Specification.
