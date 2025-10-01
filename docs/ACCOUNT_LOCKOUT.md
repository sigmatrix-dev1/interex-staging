# Account Lockout Policy

Last updated: 2025-10-01

This document describes the account lockout policy implemented in InterEx, including thresholds, user messaging, audit coverage, and unlock procedures.

## Summary

- Soft lock: 3 consecutive invalid password attempts.
- Hard lock: 3 invalid attempts within 30 seconds (rapid attempts, suspected attack).
- On soft lock: user must self-serve via Reset Password.
- On hard lock: admin-only unlock is required (Forgot Password is blocked).
- Audits: ACCOUNT_SOFT_LOCKED, ACCOUNT_HARD_LOCKED, ACCOUNT_UNLOCKED with context.

## Behavior Details

1) Pre-checks during login
- If a user is Hard Locked, the login attempt is blocked and a prominent red banner appears with a warning icon and guidance to contact an administrator.
- If a user is Soft Locked, the login attempt is blocked and a prominent yellow banner appears instructing the user to reset their password to unlock.

2) Failed attempts handling
- For a known username with an invalid password, we increment `failedLoginCount` and determine whether attempts are rapid (within 30 seconds).
- Thresholds
  - On 3rd consecutive failure → Soft Lock (if not rapid)
  - On 3 rapid failures (≤ 30s total) → Hard Lock
- Messages include remaining attempts (after 1st and 2nd failure) to help the user avoid lockout.

3) Success handling
- On successful password verification, `failedLoginCount` is reset to 0 and any Soft Lock flag is cleared.

4) Auditing
- ACCOUNT_SOFT_LOCKED: Emitted when a user is soft locked. Category: SECURITY; Status: WARNING.
- ACCOUNT_HARD_LOCKED: Emitted when a user is hard locked. Category: SECURITY; Status: FAILURE.
- ACCOUNT_UNLOCKED: Emitted when the account becomes unlocked:
  - By user action: successful Reset Password clears Soft Lock and failed counter.
  - By admin action: explicit Unlock in Admin → Users.
- Login failures and lock decisions include proxy-aware actor IP, user agent, and safe metadata (e.g., username).

## Unlock Procedures

- Soft Lock (self-service)
  - Action: Forgot/Reset Password flow.
  - Effect: Clears `softLocked` and resets `failedLoginCount`.
  - Audit: ACCOUNT_UNLOCKED with reason PASSWORD_RESET.

- Hard Lock (admin-only)
  - Action: Admin Users page → Unlock button on a locked user.
  - Effect: Clears `hardLocked`, `softLocked`, `hardLockedAt`, and resets `failedLoginCount`.
  - Audit: ACCOUNT_UNLOCKED with actor = admin, target = locked user.

Forgot Password behavior
- Soft-locked users: Allowed. The flow proceeds and emails the reset code/link. A banner may still show the reason for the lock to encourage reset.
- Hard-locked users: Blocked. The Forgot Password page shows a red banner (“Password reset disabled”) advising to contact an administrator; no email is sent.

## Database Fields

Added to `User` model (Prisma):
- `failedLoginCount Int @default(0)`
- `softLocked Boolean @default(false)`
- `hardLocked Boolean @default(false)`
- `hardLockedAt DateTime?`

Indexes
- `@@index([hardLocked])` for quick filter on admin view.

## UI Touchpoints

- Login screen: prominent banners (red for Hard Lock, yellow for Soft Lock); remaining attempts are shown on the field-level message for early failures.
- Forgot Password: prominent banner on hard-locked accounts; soft-locked users proceed normally.
- Admin → Users: 
  - Status column shows Active/Inactive.
  - Lockout column shows Hard lock or Soft lock badges when applicable.
  - Unlock action appears for locked users (role-gated).

## Configuration

- Current thresholds are fixed in code: 3 attempts (soft), 3 rapid attempts within 30 seconds (hard).
- Future tunables may include env-driven values such as `LOCKOUT_MAX_ATTEMPTS` and `LOCKOUT_WINDOW_SECONDS`.

## Notes

- Lockout logic runs before 2FA checks and session creation to prevent bypass.
- All audit entries leverage proxy-aware IP extraction and PHI minimization rules.
