# Security & Hardening Enhancement Phases

Last updated: 2025-10-03

Purpose: Provide a structured, low‑risk sequence of enhancements ("phases") that we can execute iteratively without destabilizing existing functionality. Each item includes: What, Why (risk/value), Scope & Impact, Implementation Outline, Rollout / Backout Plan, Metrics of Success, and Dependency / Migration notes.  
Guiding Principles: (1) Additive changes first (feature flags & config), (2) Backwards-compatible schema only (no destructive migrations until explicitly approved), (3) Observability before enforcement (measure, then lock down), (4) Small blast radius per deploy.

---

## Phase 0 – Immediate Risk Reduction (Fast Wins, No Schema Changes)

Focus: Strengthen perimeter against brute force & XSS; improve audit fidelity. Estimated duration: 1–3 engineering days.

| Feature | Why (Risk) | Value |
|---------|------------|-------|
| Auth Rate Limiting (login, 2FA verify, reset) | Brute force & credential stuffing currently unthrottled | Reduces automated attack success window; lowers noise in logs |
| Enforce (or activate) CSP (remove `reportOnly`) | XSS protection currently observational only | Hard mitigation of inline/script injection; compliance improvement |
| Security Events: `LOGIN_FAILURE`, `MFA_FAILURE` | Limited visibility into failed attempts | Enables anomaly detection, trending & dashboards |
| Central Active User Query Helper (excludes `deletedAt`) | Risk of accidental inclusion of soft-deleted users | Consistent correctness & reduces logic duplication |
| Privileged 2FA Policy Gate (warn-only mode) | High-privilege accounts may skip 2FA | Prepares for mandatory 2FA with zero breakage now |

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

### 0.5 Privileged 2FA Warn Gate
**Scope**: If `system-admin` or `customer-admin` logs in without 2FA enabled, display interstitial banner & issue audit `ADMIN_2FA_NOT_ENABLED_WARNING`. No hard block yet.  
**Value**: Smooth cultural adoption; metrics for readiness of mandatory enforcement.

---

## Phase 1 – Core Security Hardening (Some Additive Schema)

Focus: Account brute force resilience, credential recovery integrity, stronger secret protection. Est. 1–2 weeks.

| Feature | Why | Value |
|---------|-----|-------|
| Account Lockout / Adaptive Cooldown | Unlimited retries presently | Thwarts automated guessing; signals abuse earlier |
| CSRF Token (double-submit) | Reliance on SameSite only | Defense-in-depth; protects if cookie policy changes |
| Encrypted 2FA Secret Storage | Plain secret exposure on DB compromise | Makes TOTP secret unusable without key |
| 2FA Recovery Codes | Admin resets required when device lost | Self-service recovery; reduces support; preserves security |
| (Removed – Passkey Re-Integration) | Passkey auth out of scope | — |

### 1.1 Account Lockout
**Schema (Additive)**: `User.failedLoginCount Int @default(0)`, `User.lockedUntil DateTime?` (Additive only—safe).  
**Logic**: Increment on `LOGIN_FAILURE`; reset on success; lockout threshold e.g. 10 failures / 10 min; exponential backoff (cooldown grows).  
**Audit**: `AUTH_LOCKOUT_TRIGGERED`, `AUTH_LOCKOUT_CLEARED`.  
**Flags**: `LOCKOUT_ENABLED`, `LOCKOUT_THRESHOLD`, `LOCKOUT_WINDOW_SEC`, `LOCKOUT_BASE_COOLDOWN_SEC`.  
**Migration Safety**: New nullable columns; no rewrite of existing data.

### 1.2 CSRF Protection
**Approach**: Session-stored nonce + hidden form token. Verify on all state-changing POST/PUT/DELETE except pure API token endpoints.  
**Edge Cases**: Gracefully allow idempotent GET; handle multi-tab flows.  
**Backward Compatibility**: Add progressive validation; log missing token first (warn mode) then enforce.

### 1.3 2FA Secret Encryption
**Approach**: AES-256-GCM with master key `TOTP_ENC_KEY` (32 bytes).  
**Migration**: Script reads plaintext `twoFactorSecret`, writes encrypted blob (base64 + IV + tag). Idempotent: detect already-encrypted prefix.  
**Runtime**: Decrypt only during verification; keep secret ephemeral in memory.  
**Backout**: Keep fallback path if key missing → decline enabling new 2FA until restored.

### 1.4 Recovery Codes
**Schema**: New model `TwoFactorRecoveryCode { id, userId, codeHash, usedAt DateTime? }`.  
**Generation**: 10 random codes (e.g. base32 segments); store bcrypt hash; show once; downloadable/printable.  
**Usage**: Accept code if hash matches & not used; mark used; audit `2FA_RECOVERY_USED`.  
**Value**: Avoids disabling 2FA when device lost.  
**Backout**: Pure additive; safe to ignore unused table.

### 1.5 (Removed – Passkey Re-Integration)
Passkey authentication intentionally excluded. Number retained for historical continuity; future advanced auth (e.g., hardware security keys) could reuse the slot if scope changes.

---

## Phase 2 – Operational Maturity & Compliance

Focus: Continuous integrity, retention, telemetry, anomaly detection. Est. 2–3 weeks.

| Feature | Why | Value |
|---------|-----|-------|
| Automated Audit Chain Verification Job | Manual only now | Early tamper detection & trust signals |
| Audit Archival / Retention Policy | Infinite growth risk | Performance + compliance alignment |
| Structured App Telemetry (AppLog adoption) | Sparse operational signals | Faster triage, metric foundation |
| Anomaly Detection (login spikes) | Hard to notice distributed attacks | Faster incident response |
| Mandatory 2FA for Privileged Roles | Phase 0 data readiness | Hardens admin accounts |

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

### 2.5 Enforce Privileged 2FA
**Switch**: Flip warn gate to hard requirement (block session issuance if system-admin|customer-admin lacks 2FA).  
**Grace Period**: Communicate cutover date > 1 week ahead using in-app banner.

---

## Phase 3 – Advanced & Strategic Enhancements

Focus: High-assurance authentication, adaptive security, forensics, polished compliance offerings. Ongoing / optional.

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
0 | None | Yes
1 | `User.failedLoginCount`, `User.lockedUntil`, `TwoFactorRecoveryCode` table | Yes
2 | Optional `Session.trusted` (if early), none mandatory | Yes
3 | Optional additional columns (`Session.trusted` if deferred, export keys table if needed) | Yes

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

Flag | Purpose | Default
-----|---------|--------
AUTH_RATE_LIMIT_ENABLED | Turn auth rate limiting on/off | false
AUTH_RATE_LIMIT_WINDOW_SEC | Sliding window size | 60
AUTH_RATE_LIMIT_MAX | Max attempts per window per IP | 10
LOCKOUT_ENABLED | Activate lockout logic | false
LOCKOUT_THRESHOLD | Failures before lock | 10
LOCKOUT_WINDOW_SEC | Rolling window for counting | 600
LOCKOUT_BASE_COOLDOWN_SEC | Initial lock period | 300
PRIVILEGED_2FA_WARN | Show warning for admin w/o 2FA | true
PRIVILEGED_2FA_ENFORCE | Hard block without 2FA | false
TOTP_ENC_KEY | 32-byte key for 2FA secret encryption | (unset)
RECOVERY_CODES_COUNT | Number of codes to generate | 10
PASSKEY_REQUIRED_ROLES | (Deprecated – no effect) | (empty)
ANOMALY_THRESHOLD_FAILURES | Failures per IP/user to flag anomaly | 50
AUDIT_ARCHIVE_DAYS | Age threshold for archival | 180
AUDIT_VERIFY_SCHEDULE_CRON | Cron expression for chain verify | daily

---

Questions or adjustments: edit this file and reference commit links in PR descriptions so the roadmap stays authoritative.
