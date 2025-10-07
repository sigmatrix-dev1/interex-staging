# Security & Hardening Enhancement Phases

Last updated: 2025-10-06

Purpose: Provide a structured, low‑risk sequence of enhancements ("phases") that we can execute iteratively without destabilizing existing functionality. Each item includes: What, Why (risk/value), Scope & Impact, Implementation Outline, Rollout / Backout Plan, Metrics of Success, and Dependency / Migration notes.  
Guiding Principles: (1) Additive changes first (feature flags & config), (2) Backwards-compatible schema only (no destructive migrations until explicitly approved), (3) Observability before enforcement (measure, then lock down), (4) Small blast radius per deploy.

---

## Phase 0 – Immediate Risk Reduction (Fast Wins, No Schema Changes)

Status: Completed (2025-10-05)

Focus: Strengthened perimeter against brute force & XSS; improved audit fidelity; elevated MFA from planned privileged-only warning to universal mandatory enforcement (superseding the originally scoped warn gate). Estimated duration (actual): ~3 engineering days spread across multiple commits.

| Feature | Why (Risk) | Value | Status |
|---------|------------|-------|--------|
| Auth Rate Limiting (login, 2FA verify, reset) | Brute force & credential stuffing unthrottled | Reduces automated attack window; lowers log noise | Shipped |
| Enforce CSP (removed `reportOnly`) | XSS protection previously observational | Hard mitigation of injection; compliance | Shipped |
| Failure Security Events (`LOGIN_FAILURE`, `MFA_VERIFY_FAILED`, etc.) | Limited visibility into failed attempts | Enables anomaly detection & future lockout tuning | Shipped |
| Central Active User Query Helper | Risk of soft-deleted users leaking into logic | Consistent correctness | Shipped |
| Universal Mandatory TOTP MFA Enforcement | Password-only sessions vulnerable to takeover | Dramatically raises bar for credential abuse; consistent policy | Shipped (replaced privileged warn gate) |
| Expanded Audit Events (MFA_SETUP_START, MFA_ENABLE, MFA_VERIFY, MFA_VERIFY_FAILED, MFA_ENFORCE_BLOCK, MFA_RESET, LOGOUT_OTHERS_ON_LOGIN) | Need traceability of auth lifecycle & resets | Forensics & anomaly baselining | Shipped |

Deferred/Removed From Phase 0: Original "Privileged 2FA Warn Gate" superseded by immediate universal enforcement (higher value, limited complexity) after scope change decision.

### 0.1 Auth Rate Limiting
**Scope**: Add Express middleware wrapping only public auth endpoints. Store counters in-memory first (acceptable for short-term) with env-configured ceilings (e.g. 10/min/IP, small burst window).  
**Implementation**: Wrap in server entry or route layer; structured `SecurityEvent` on block (`RATE_LIMIT_BLOCK`).  
**Rollout**: Start in “monitor mode” logging prospective blocks (dry-run) for 24h, then flip to enforce.  
**Metrics**: Count of blocked vs successful attempts; p95 login latency unchanged; no false-positive complaints.  
**Dependencies**: None.  
**Backout**: Toggle env flag `AUTH_RATE_LIMIT_ENABLED=false`.

### 0.2 CSP Enforcement
**Scope**: Remove `reportOnly: true`; add stricter directives: `object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests` (if acceptable).  
**Value**: Hardens against reflected/stored XSS and clickjacking.  
**Pre-Check**: Review report logs for violations; whitelist any sanctioned external domains (e.g. Sentry).  
**Backout**: Reintroduce reportOnly flag if unexpected breakage.

### 0.3 Failure Security Events
**Scope**: Emit `SecurityEvent` for each failed password login, failed 2FA token, and future passkey failures. Include IP (privacy mode applied), masked username, reason code.  
**Value**: Baseline analytics for Phase 1 lockout thresholds.  
**Rollout**: Immediate; minimal risk.

### 0.4 Active User Helper
**Scope**: Utility `getActiveUser(id)` and shared where clauses; update sensitive queries gradually.  
**Value**: Prevents “ghost” access regressions when soft delete is widely used.

### 0.5 Universal Mandatory TOTP MFA Enforcement
**Scope**: All users must register & verify a TOTP secret (via provisional session) before a full session is issued. Login flow: password success -> if user lacks secret -> redirect to `/2fa-setup`; else -> redirect to `/2fa` for verification. Blocks application access (other than setup/verification routes) until satisfied. Reverify routes support step-up flows. Admins may reset user MFA (audited).  
**Value**: Eliminates class of password-only compromises; simplifies policy messaging (no role carve-outs).  
**Backout**: (Not planned) would require reintroducing conditional gating and removal of enforcement redirects. No toggle presently because universal MFA is a baseline assumption going forward.

---

## Phase 1 – Core Security Hardening & Auth Artifact Cleanup (Some Additive Schema)

Status: Completed (2025-10-06)

Focus: Close remaining auth attack surface (lockout, CSRF), strengthen MFA secret protection & recovery, and physically remove legacy OAuth/provider artifacts to reduce code & dependency footprint. Est. 1–2 weeks (actual: ~9 active engineering days with intermittent context switching).

| Feature | Why | Value | Status / Notes |
|---------|-----|-------|-----------------|
| OAuth / Provider Artifact Purge | Dead code increased surface | Smaller supply chain | Completed – all provider routes, tests, strategies removed; dependency cruft dropped |
| Schema Cleanup (Connection tables/models) | Unused connection data | Lower confusion | Deferred (explicit approval required); non-blocking for Phase 1 completion |
| Account Lockout / Adaptive Cooldown | Unlimited retries | Brute force mitigation | Completed (flagged). Columns live; feature behind `LOCKOUT_ENABLED`. Baseline tests + manual unlock path validated. Threshold tuning deferred to Phase 2 metrics window |
| CSRF Token (double-submit) | SameSite reliance | Defense in depth | Completed. Default runtime mode: `log`; test environment enforces (deterministic 403). All form POST routes instrumented with `<CsrfInput />`. Future: flip prod `CSRF_MODE=enforce` after 7d metrics review |
| Encrypted 2FA Secret Storage | Secret plaintext risk | At-rest protection | Completed. AES-256-GCM helpers + migration script (`prisma/scripts/migrate-encrypt-totp-secrets.ts`) shipped; supports `MFA_ENCRYPTION_KEY` alias |
| 2FA Recovery Codes (privileged only) | Device loss resets | Self-service for admins | Completed. Restricted to `system-admin` & `customer-admin`. Generation, single-use consumption & regeneration audited and tested |
| Passkey Support Removal | Out of scope | Shrink attack surface | Completed. Model & e2e test removed. Residual routes replaced with 404 stubs (can be fully deleted in Phase 2 cleanup) |

Success Criteria Phase 1 (final):
* Provider & passkey artifacts removed (no runtime dependency on OAuth or WebAuthn libs)
* Lockout additive schema + flag + baseline tests
* CSRF infrastructure applied to all mutation forms; log mode default, enforce in tests
* TOTP secrets encrypted at rest with migration/backfill script
* Privileged recovery codes (issue, consume, regenerate) implemented + audited
* Audit events extended for new auth flows
* Baseline security tests: lockout, CSRF positive/negative, recovery codes (privileged & non-privileged), MFA recovery login

Deferred / Post-Phase Tasks:
* Optional destructive removal of connection/provider tables
* Production flip of `CSRF_MODE=enforce` after observational window
* Lockout threshold & cooldown tuning from collected metrics
* Full deletion of placeholder WebAuthn stub routes (low priority)

### Phase 1 Completion Snapshot

Artifacts:
* Migration(s): `add_account_lockout`, `add_recovery_codes`
* Script: `prisma/scripts/migrate-encrypt-totp-secrets.ts`
* Tests Added: `tests/security/csrf.test.ts`, `tests/security/csrf-positive.test.ts`, `tests/security/recovery-codes.test.ts`, updated lockout tests
* Env Flags: `LOCKOUT_ENABLED`, `LOCKOUT_THRESHOLD`, `LOCKOUT_WINDOW_SEC`, `LOCKOUT_BASE_COOLDOWN_SEC`, `CSRF_MODE`, `RECOVERY_CODES_COUNT`, `TOTP_ENC_KEY`/`MFA_ENCRYPTION_KEY`
* Documentation: Updated to reflect removal of privileged-only MFA warn gate and provider/passkey code

Risk Review:
* All schema changes additive; rollback = ignore columns & drop table later if needed
* Encryption backfill script idempotent (detects already-encrypted secrets)
* CSRF enforcement staged (tests enforce, runtime logs) reducing production blast radius

Go / No-Go Notes:
* No pending critical TODO blocking enforcement flips
* Observability (audit + security events) in place for subsequent tuning

### 1.0 Provider Artifact Purge & Dependency Removal
**Scope**: Delete `app/utils/providers/*`, connection utilities, legacy OAuth routes/tests (`auth.$provider.*`, `onboarding_.$provider.*`, connection UI placeholder removal), and remove `remix-auth-github`. If no remaining strategies, remove `remix-auth` base package. Update README & TECHNICAL_SPEC to remove residual references.  
**Verification**: Grep for `GitHubStrategy`, `remix-auth`, `connection`, ensure only domain meaning uses remain. Typecheck + tests green.  
**Backout**: Restore from VCS; dependencies can be re-added.  
**Audit**: None (pure code removal).

### 1.1 Schema Cleanup (Optional / Approval Needed)
**Scope**: Drop unused connection / provider tables or columns. Provide pre-migration data export (even if unused) for provenance.  
**Migration**: Destructive—must be signed off.  
**Backout**: Restore from backup + revert migration.  
**Note**: Can be deferred to a maintenance window or grouped with future schema changes.

### 1.2 Account Lockout
**Schema (Additive)**: `User.failedLoginCount Int @default(0)`, `User.lockedUntil DateTime?` (Additive only—safe).  
**Logic**: Increment on `LOGIN_FAILURE`; reset on success; lockout threshold e.g. 10 failures / 10 min; exponential backoff (cooldown grows).  
**Audit**: `AUTH_LOCKOUT_TRIGGERED`, `AUTH_LOCKOUT_CLEARED`.  
**Flags**: `LOCKOUT_ENABLED`, `LOCKOUT_THRESHOLD`, `LOCKOUT_WINDOW_SEC`, `LOCKOUT_BASE_COOLDOWN_SEC`.  
**Migration Safety**: New nullable columns; no rewrite of existing data.

### 1.3 CSRF Protection
**Approach**: Session-stored nonce + hidden form token. Verify on all state-changing POST/PUT/DELETE except pure API token endpoints.  
**Edge Cases**: Gracefully allow idempotent GET; handle multi-tab flows.  
**Backward Compatibility**: Add progressive validation; log missing token first (warn mode) then enforce.

### 1.4 2FA Secret Encryption
**Approach**: AES-256-GCM with master key `TOTP_ENC_KEY` (32 bytes).  
**Migration**: Script reads plaintext `twoFactorSecret`, writes encrypted blob (base64 + IV + tag). Idempotent: detect already-encrypted prefix.  
**Runtime**: Decrypt only during verification; keep secret ephemeral in memory.  
**Backout**: Keep fallback path if key missing → decline enabling new 2FA until restored.

### 1.5 Recovery Codes
**Schema**: New model `TwoFactorRecoveryCode { id, userId, codeHash, usedAt DateTime? }`.  
**Generation**: 10 random codes (e.g. base32 segments); store bcrypt hash; show once; downloadable/printable.  
**Usage**: Accept code if hash matches & not used; mark used; audit `2FA_RECOVERY_USED`.  
**Value**: Avoids disabling 2FA when device lost.  
**Backout**: Pure additive; safe to ignore unused table.

### 1.6 (Removed – Passkey Re-Integration)
Passkey authentication intentionally excluded. Number retained for historical continuity; future advanced auth (e.g., hardware security keys) could reuse the slot if scope changes.

---

## Phase 2 – Operational Maturity & Compliance

Focus: Continuous integrity, retention, telemetry, anomaly detection. (Privileged-only MFA enforcement removed—already universal baseline). Est. 2–3 weeks.

| Feature | Why | Value |
|---------|-----|-------|
| Automated Audit Chain Verification Job | Manual only now | Early tamper detection & trust signals |
| Audit Archival / Retention Policy | Infinite growth risk | Performance + compliance alignment |
| Structured App Telemetry (AppLog adoption) | Sparse operational signals | Faster triage, metric foundation |
| Anomaly Detection (login spikes) | Hard to notice distributed attacks | Faster incident response |
| Session Trust / Hygiene Enhancements (extend logout-others auditing) | Need richer session context | Improves incident response & UX balance |

### 2.1 Audit Verification Scheduler
**Approach**: Background cron (e.g. node schedule or Fly Machines timer) running `verifyAllChains()` daily; store summary in `AppLog` and emit `SYSTEM` audit on mismatch.  
**Dashboard**: Simple page widget: last run timestamp, chains checked, mismatches count.

### 2.2 Archival Job
**Policy**: Move events older than N days (e.g. 180) to `AuditEventArchive`; keep indexes lean.  
**Job**: Batched copy + delete inside transaction per chain range.  
**Metrics**: Rows moved per run; size before/after.

### 2.3 AppLog Expansion
**Pattern**: Introduce `logEvent({ module, event, level, data })` wrapper; gradually instrument submissions, 2FA, letters sync.  
**Value**: Enables charts (rates over time) & correlates with security events.

### 2.4 Anomaly Detection
**Logic**: Sliding counts of `LOGIN_FAILURE` per IP / per user; threshold triggers `SECURITY_ANOMALY` event + optional admin notification (email or future notification center).  
**No Schema** if ephemeral in memory; optional `LoginAttempt` table if persistence required.

### 2.5 Session Trust / Hygiene Enhancements
Leverage existing `LOGOUT_OTHERS_ON_LOGIN` audit to add optional stale-session revocation policies or trusted session labeling groundwork (non-security breaking, UX driven).

---

## Phase 3 – Advanced & Strategic Enhancements

Focus: Adaptive security, higher assurance, forensic export integrity, enterprise telemetry. Ongoing / optional.

| Feature | Why | Value |
|---------|-----|-------|
| Trusted Device / Session Risk Scoring | Reduce friction post-2FA | Balances UX vs security dynamically |
| Adaptive / Step-Up Auth | Heightened risk events (geo/IP change) | Minimizes blanket friction while containing risk |
| (Removed – Passkey Only Mode) | Passkey auth out of scope | — |
| Signed Audit Export Packages | Forensic integrity & external regulators | Streamlined investigations |
| External SIEM Streaming | Centralized security analytics | Enterprise readiness |

### 3.1 Trusted Device Flag
**Schema** (optional): `Session.trusted Boolean @default(false)` additive. Mark after first successful 2FA / passkey; bypass repeated 2FA unless risk signal changes.

### 3.2 Adaptive Auth
**Signals**: New IP ASN, unusual login hour, high failure velocity. Escalate to fresh TOTP or passkey even if session valid.  
**Data**: Use existing audit + security events; minimal new schema at start.

### 3.3 (Removed – Passkey Only Roles)
Removed from roadmap; not planned.

### 3.4 Signed Audit Export
**Process**: Export JSON/CSV + manifest file with hash + signature (ed25519 key).  
**Verification Tool**: Simple CLI verifying chain + signatures offline.

### 3.5 SIEM Streaming
**Approach**: Pluggable sink interface; start with HTTPS batch forwarder of normalized events (Audit/Security/AppLog).  
**Backpressure**: In-memory queue with drop policy for non-critical logs.

---

## Cross-Phase Considerations

Aspect | Strategy
-------|---------
Feature Flags | Every enforcement feature behind env flag; progressive rollout path: off → log-only → soft-warn → enforce.
Schema Migrations | Only additive columns/tables (no renames/drops) until stability proven; version each change in docs.
Observability First | Before enforcing lockout or adaptive auth, gather metrics for at least 7 days.
Backout Plans | For each enforcement, a single env toggle reverts behavior; code paths maintain legacy fallback for two releases.
Testing | Add unit + integration tests per phase; Playwright flows for login lockout and recovery code usage.
Documentation | Update this file and the main Technical Spec after each phase completion (append “Completed On” date).

---

## Migration Summary (Additive Only)

Phase | Migration Elements | Backwards Compatible?
------|--------------------|-----------------------
0 | None | Yes (Completed)
1 | `User.failedLoginCount`, `User.lockedUntil`, `TwoFactorRecoveryCode` table (additive); optional provider connection table drop (destructive – approval required) | Additive parts: Yes; Destructive table drop: No (requires approval)
2 | Optional `Session.trusted` (if introduced here) | Yes
3 | Optional additional columns (export signing keys) | Yes

All new tables/columns are nullable / defaulted, avoiding impact on existing queries until code starts referencing them.

---

## Metrics Dashboard (Recommended Minimal Set)

Category | Metric | Purpose
---------|--------|--------
Auth | Login success rate (%), failure count, lockout count | Detect brute force & friction
2FA | 2FA adoption rate by privileged role | Track readiness for enforcement
Security | Rate-limited requests per endpoint | Tune thresholds
Audit | Chain verification pass %, rows archived | Integrity & storage health
Operational | p95 login latency, error rate | Ensure changes don’t regress UX

---

## Execution Checklist (Per Feature)

1. Design stub (doc or inline ADR comment)
2. Add env flag & default OFF
3. Implement code path (log-only if enforcement)
4. Add tests (unit + e2e if user-facing)
5. Enable in staging (collect metrics)
6. Promote to warn → enforce (as applicable)
7. Update this document & Technical Spec
8. Retrospective notes (issues, tuning adjustments)

---

## Appendix: Suggested ENV Flags

Flag | Purpose | Default | Notes
-----|---------|--------|-------
AUTH_RATE_LIMIT_ENABLED | Turn auth rate limiting on/off | false | Phase 0 feature
AUTH_RATE_LIMIT_WINDOW_SEC | Sliding window size | 60 | 
AUTH_RATE_LIMIT_MAX | Max attempts per window per IP | 10 | 
LOCKOUT_ENABLED | Activate lockout logic | false | Phase 1
LOCKOUT_THRESHOLD | Failures before lock | 10 | Phase 1
LOCKOUT_WINDOW_SEC | Rolling window for counting | 600 | Phase 1
LOCKOUT_BASE_COOLDOWN_SEC | Initial lock period | 300 | Phase 1
TOTP_ENC_KEY | 32-byte key for 2FA secret encryption | (unset) | Phase 1 (encryption)
RECOVERY_CODES_COUNT | Number of codes to generate | 10 | Phase 1
ANOMALY_THRESHOLD_FAILURES | Failures per IP/user to flag anomaly | 50 | Phase 2
AUDIT_ARCHIVE_DAYS | Age threshold for archival | 180 | Phase 2
AUDIT_VERIFY_SCHEDULE_CRON | Cron expression for chain verify | daily | Phase 2

Removed / Obsolete Flags: `PRIVILEGED_2FA_WARN`, `PRIVILEGED_2FA_ENFORCE`, `PASSKEY_REQUIRED_ROLES` (superseded by universal MFA baseline and scope reduction).

---

Questions or adjustments: edit this file and reference commit links in PR descriptions so the roadmap stays authoritative.
