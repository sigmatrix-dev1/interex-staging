## MFA & Auth Rate Limiting Test Plan

Last updated: 2025-10-03

### Scope
Validation of TOTP-based MFA (enablement, verification, enforcement) and authentication rate limiting middleware. Ensures non system-admin users cannot bypass MFA, privileged banner logic works, and auth endpoints throttle abusive patterns.

### Environments & Flags
Flag | Expected for Tests | Notes
-----|--------------------|------
`AUTH_RATE_LIMIT_ENABLED` | true (for limiter tests) | Set false to skip blocking assertion.
`AUTH_RATE_LIMIT_WINDOW_SEC` | 60 (default) | Use small window if needing faster reset locally.
`AUTH_RATE_LIMIT_MAX` | 10 (default) | Adjust downward for stress tests.
`PRIVILEGED_2FA_WARN` | true | Needed to see banner tests (future addition).
`PRIVILEGED_2FA_ENFORCE` | false | Hard privileged block not yet enabled.

### Test Categories
1. MFA Enablement Flow (user settings)
2. MFA Login Verification Flow (/2fa)
3. Enforcement Redirect (non system-admin w/o MFA)
4. Privileged Warning (system-admin w/o MFA) – TODO add test when fixture helper can create system-admin
5. Rate Limiting (failed password attempts; MFA attempts optional)
6. Audit Event Emission Smoke (optional integration assertions)

### Detailed Test Cases

ID | Title | Pre-Conditions | Steps | Expected Result
---|-------|---------------|-------|----------------
MFA-01 | Enable MFA via /me/2fa | User logged in without MFA | Visit /me/2fa → Click Set up → Capture secret → Generate OTP → Submit | Redirect back to /me/2fa showing enabled state, audit events `MFA_SETUP_START` + `MFA_ENABLE`.
MFA-02 | Login requires MFA when enabled | User has enabled MFA | Logout → Login with username/password | Redirect to /2fa page asking for code; valid code logs in; audit `MFA_VERIFY`.
MFA-03 | Invalid MFA code logs failure | User has enabled MFA | On /2fa enter incorrect 6-digit code | Error message, audit `MFA_VERIFY_FAILED`, stay on /2fa.
MFA-04 | Enforcement for non system-admin w/o MFA | User (basic-user) with no MFA | Login normally | Redirect to /2fa-setup, audit `MFA_ENFORCE_BLOCK`.
MFA-05 | System-admin allowed without MFA (warn) | System-admin user no MFA | Login | Logged in; (banner visible later); audit `ADMIN_MFA_NOT_ENABLED_WARNING` (from login path) – not blocked.
MFA-06 | Auth rate limiting triggers on repeated bad logins | Rate limiting enabled | Perform > AUTH_RATE_LIMIT_MAX invalid password attempts on /login | Eventually 429 response or UI indicating throttle; optional security event (future) – test asserts block.
MFA-07 | Auth rate limiter unaffected when disabled | AUTH_RATE_LIMIT_ENABLED=false | Same as MFA-06 | No throttling encountered; no 429.
MFA-08 | MFA enforcement does not double-create sessions | Non system-admin no MFA | Login; follow redirect chain | Only unverified session ID stored in verify session; full session cookie absent until MFA complete (manual inspection or helper) – optional.
MFA-09 | Successful MFA after enforcement flow | Non system-admin enabling MFA during redirect path | Start login → redirected to /2fa-setup → enable → redirected/committed | Full auth session established; audit events sequence: `MFA_SETUP_START`, `MFA_ENABLE`, (implicit login success previously), no stray duplicates.
MFA-10 | Rate limiter does not block normal MFA success path | Fresh user with MFA | One password attempt then one MFA attempt | No 429; success.

### Implemented Automated Tests
File | Covers
-----|-------
`tests/e2e/2fa.test.ts` | MFA-01, MFA-02 (basic enable + login verification)
`tests/e2e/mfa-enforcement.test.ts` | MFA-04, MFA-02 variant (non admin with & without MFA)
`tests/e2e/rate-limit-auth.test.ts` | MFA-06 (conditional on flag)
`tests/e2e/mfa-invalid-code.test.ts` | MFA-03 (invalid code path)
`tests/e2e/mfa-admin-warning.test.ts` | MFA-05 (system-admin allowed without MFA)

### Gaps / TODO for Future Automation
- (Banner visual assertion still optional; presence test implemented in `mfa-admin-warning.test.ts`)
- MFA-05 privileged warning banner (needs role creation helper for system-admin) – TODO
- MFA-07 disabled limiter scenario (run matrix in CI with flag off) – TODO
- MFA-08/09 session integrity & event ordering – optional integration test reading audit table – TODO
- Recovery codes (Phase 1) – future test set
- Lockout interaction with rate limiter – future after feature implemented

### Manual Validation Checklist (Release Candidate)
- [ ] Non admin login without MFA always redirects to setup
- [ ] Enabling MFA via setup during enforced flow results in full session after code verify
- [ ] System-admin login proceeds & shows banner (once implemented in layout path visible to test)
- [ ] Rate limiting blocks after configured threshold (inspect 429 status)
- [ ] No sensitive secrets or plain MFA codes stored in logs (sample audit rows)

### Rollback Considerations
Set `AUTH_RATE_LIMIT_ENABLED=false` to disable limiter; enforcement code still forces MFA for non-admin (requires code change to revert). For emergency rollback of enforcement, conditional wrapper could be added behind new flag `MFA_ENFORCE_NON_ADMIN=false` (not currently implemented).

### References
- `app/routes/_auth+/login.server.ts` (session handling & enforcement)
- `app/routes/_auth+/2fa-setup.tsx`, `app/routes/_auth+/2fa.tsx`
- `app/routes/me.2fa.tsx`
- `server/index.ts` (rate limiter injection)
- `app/utils/twofa.server.ts`
- `docs/SECURITY_ENHANCEMENT_PHASES.md`

---
Additions or corrections should update this file and link the PR.