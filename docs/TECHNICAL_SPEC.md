# InterEx Technical Specification

Last updated: 2025-09-24

This document describes the implemented features, technical architecture, security and compliance controls, logging, external API integrations, and the database tables used by each module in the InterEx application.

- Tech stack: Remix (React + TypeScript), Prisma ORM (SQLite/LiteFS), Zod + Conform for forms, Tailwind UI, Playwright tests
- Key integrations: PCG HIH Wrapper APIs (submissions, providers/eMDR, letters), email, TOTP 2FA

## Modules and Features

### Authentication (Login, 2FA, Forgot/Reset, Logout)

Routes and files
- Login UI/Action: `app/routes/_auth+/login.tsx`
- 2FA verify UI/Action: `app/routes/_auth+/2fa.tsx`
- 2FA settings UI (enable/disable): `app/routes/me.2fa.tsx`
- Forgot password (request reset): `app/routes/_auth+/forgot-password.tsx`
- Reset flow server helpers: `app/routes/_auth+/verify.server.ts`, `reset-password.*`
- Force change password: `app/routes/change-password.tsx`
- Logout: `app/routes/_auth+/logout.tsx`

Features
- Username/password login with honeypot anti-bot, Zod validation, and clean UI
- TOTP 2FA using secure server-side secret generation and verification
  - If a user has 2FA enabled, login redirects to `/auth/2fa` before session creation
  - 2FA secrets stored on `User.twoFactorSecret`; toggle with `twoFactorEnabled`
- Forgot/Reset password
  - Generates a time-limited verification (OTP + link) via `prepareVerification` and emails the user
- Forced password change
  - Users flagged with `User.mustChangePassword = true` are redirected to `/change-password` and blocked from app until a compliant password is set
- Logout invalidates session and redirects to root

Security/Logging
- Security events saved in `SecurityEvent` when admins send a reset link or manually reset passwords
- Audit events recorded in admin flows (see Audit Logging) when applicable

Tables used
- `User`, `Password`, `Session`, `Verification`, `SecurityEvent`

2FA documentation: `2FA-IMPLEMENTATION.md`

Password policy: Enforced in `app/utils/password-policy.server.ts` and `change-password.tsx`
- Length 12–24, at least one uppercase, lowercase, digit, special, no leading/trailing whitespace
- Breach/common check via `checkIsCommonPassword`

### Dashboard (Role-based Landing)

Routes and files
- `app/routes/dashboard.tsx`
- `app/utils/role-redirect.server.ts`

Features
- Loader detects user roles and redirects to the proper dashboard based on primary role
  - system-admin → `/admin/dashboard`
  - customer-admin → `/customer`
  - provider-group-admin → `/provider`
  - basic-user → `/customer/submissions`

Tables used
- `User` + `Role`

### Submissions

Routes and files
- `app/routes/submissions.tsx`
- PCG submission APIs: `app/services/pcg-hih.server.ts`

Features
- User-facing page shows assigned NPIs (via `UserNpi`) and a New Submission entry point (UI scaffold)
- Underlying PCG submission lifecycle supported by services:
  - Create, upload files, get status, update submission
- Coerces PCG “stage” to local status for display/tracking

Tables used
- `User`, `Provider`, `UserNpi`, `Submission`, `SubmissionDocument`, `SubmissionEvent`

External API calls (PCG)
- `pcgCreateSubmission`, `pcgUploadFiles`, `pcgGetStatus`, `pcgUpdateSubmission`

### Provider Group Management (System Admin)

Route and file
- `app/routes/admin+/customer-manage.$customerId.provider-groups.tsx`

Features
- List/Search provider groups within a customer
- Create, edit (name, description, active), and delete provider groups
- Guard rails for delete: blocks when users or providers are attached
- Drawer-based UX for create/edit, with stats (assigned users/providers)

Security/Logging
- Requires `system-admin`
- Audit events (`AuditEvent.ADMIN` category) for create/update/delete attempts and outcomes
  - Actions include: `PROVIDER_GROUP_CREATE(_ATTEMPT)`, `PROVIDER_GROUP_UPDATE(_ATTEMPT)`, `PROVIDER_GROUP_DELETE(_ATTEMPT|_BLOCKED)`, `PROVIDER_GROUP_NAME_CONFLICT`, `PROVIDER_GROUP_NOT_FOUND`

Tables used
- `Customer`, `ProviderGroup`, relations to `User` and `Provider`
  - Unique: `(customerId, name)`

### Provider NPI Management (System Admin)

Route and file
- `app/routes/admin+/customer-manage.$customerId.providers.tsx`

Features
- List/Search provider NPIs within a customer
- Create provider NPI (with optional Provider Group), update name/group/active
- Toggle active status
- Delete provider NPI with safety checks
- Assign/Unassign users to provider NPIs
- Bulk user assignment/unassignment with guard rails:
  - If provider has no group: only ungrouped users are eligible
  - If provider has a group: only users in the same group are eligible
  - Block assigning admins to NPIs
  - Block assigning a group to an ungrouped provider when ungrouped users are assigned
- Provider Group alignment banner for quick fixes when user’s group differs from provider’s group
- Drawer-based UX for create/edit; inline popovers for group/user actions

Delete behavior (guard rails)
- Block deletion when any dependents exist: assigned users, submissions, or letters (Prepay/Postpay/PostpayOther)
- UI disables delete with tooltip while blocked; shows counts in confirmation

Security/Logging
- Requires `system-admin`
- Audit events (`AuditEvent.ADMIN`) for create/update/toggle-active and assignment attempts
  - Examples: `PROVIDER_CREATE`, `PROVIDER_UPDATE`, `PROVIDER_TOGGLE_ACTIVE`, `PROVIDER_ASSIGN_USER_ATTEMPT`, `PCG_ADD_PROVIDER_NPI`, `PROVIDER_FETCH_REMOTE_NPIS`
- Delete audit coverage: `PROVIDER_DELETE` with `SUCCESS`/`FAILURE` status (includes dependent counts on failure)
- Provider business events saved in `ProviderEvent` (e.g., CREATED, UPDATED, ACTIVATED, GROUP_ASSIGNED, PCG_ADD_ERROR)

External API calls (PCG)
- `pcgAddProviderNpi` (tolerates duplicates: recorded as success)
- `pcgGetUserNpis` (org-registered NPIs)

Tables used
- `Customer`, `Provider`, `ProviderGroup`, `User`, `UserNpi`, `ProviderEvent`
  - Unique: `Provider.npi` (global), `UserNpi (userId, providerId)`

### Provider & eMDR Management (System Admin)

Service file
- `app/services/pcg-hih.server.ts`

Features
- Provider list (PCG `providers` endpoint), update provider details, and eMDR registration management
- Persist authoritative eMDR/PCG data locally for each `Provider` in dedicated tables:
  - `ProviderListDetail` for `/providers` list item details
  - `ProviderRegistrationStatus` for registration state
- Convenience mapping of PCG stages to local status

External API calls (PCG)
- List providers: `pcgGetProviders`
- Update provider details: `pcgUpdateProvider`
- eMDR register/deregister: `pcgSetEmdrRegistration`
- Get registration: `pcgGetProviderRegistration`
- Electronic Only ADR: `pcgSetElectronicOnly`

Tables used
- `Provider`, `ProviderListDetail`, `ProviderRegistrationStatus`

### Letters (All eMDR Letters — System Admin)

Route and file
- `app/routes/admin+/all-letters.tsx`
- Sync/Download services: `app/services/letters.server.ts`

Features
- Centralized view across `PrepayLetter`, `PostpayLetter`, `PostpayOtherLetter`
- Global filter bar (customer, search); per-type “Fetch new letters” controls with date ranges
- Download/View single letter as PDF (opens in a new tab)
- First-view stamping: `firstViewedAt` set once per letter (server) and reflected client-side
- ET-based due date highlighting with “days left” chips (consistency across reviewers)
- Client-side “last sync” timestamp by type (ET + Local, manual trigger)

Security/Logging
- Requires `system-admin`
- Audit events (`AuditEvent.ADMIN`) for sync and download
  - `LETTERS_SYNC`, `LETTER_DOWNLOAD`
- Letter sync metadata sanitized before writing to audit logs (PHI minimization)

External API calls (PCG)
- List: `pcgListPrePayLetters`, `pcgListPostPayLetters`, `pcgListPostPayOtherLetters`
- Download: `pcgDownloadEmdrLetterFile`

Tables used
- `PrepayLetter`, `PostpayLetter`, `PostpayOtherLetter`
  - `externalLetterId` is unique per table; `downloadId` is inferred/backfilled when missing
  - Indexed by `customerId`, `providerNpi`, `letterDate`
- Optional links to: `Provider`, `Customer`, `ProviderGroup`

### User Management (System Admin)

Route and file
- `app/routes/admin+/users.tsx`

Features
- List users (with roles, customer, NPI count), filter by customer
- Create user with generated strong temp password; user must change on first login
- Send password reset link (10-minute OTP)
- Manual password reset (sets a temp password, invalidates sessions, forces change on next login)
- Prevent creating users with `system-admin` role

Security/Logging
- Requires `system-admin`
- Security events appended for reset link and manual resets
- Audit events (`AuditEvent.ADMIN`) for user lifecycle and access changes with attempt/success/blocked variants:
  - Create: `USER_CREATE_ATTEMPT` → `USER_CREATE`
  - Update: `USER_UPDATE_ATTEMPT` → `USER_UPDATE` (includes changed fields)
  - Delete: `USER_DELETE_ATTEMPT` → `USER_DELETE` or `USER_DELETE_BLOCKED`
  - Set Active: `USER_SET_ACTIVE_ATTEMPT` → `USER_SET_ACTIVE`
  - Password Reset: `USER_RESET_PASSWORD_ATTEMPT` → `USER_RESET_PASSWORD` (mode captured)
  - Assign NPIs: `USER_ASSIGN_NPIS_ATTEMPT` → `USER_ASSIGN_NPIS`
- Emails sent via server utilities with audit-friendly content

Tables used
- `User`, `Password`, `Role`, `Customer`, `UserNpi`, `SecurityEvent`

### Logout

Route and file
- `app/routes/_auth+/logout.tsx`

Features
- Action invalidates session and returns to `/`

Tables used
- `Session`

## Database (Prisma) Overview

Schema: `prisma/schema.prisma`

Core identity and access
- `User` (2FA, forced change flags, soft delete)
- `Password` (one-to-one with User)
- `Session`
- `Role`, `Permission` (RBAC)
- `Verification` (OTP/link)
- `Passkey` (kept, not currently surfaced in UI)

Tenants and domain
- `Customer` (tenants) → has many `ProviderGroup`, `Provider`, `Submission`, Letters
- `ProviderGroup` (per Customer, unique `(customerId, name)`) → has many `User`, `Provider`, Letters
- `Provider` (global unique `npi`, scoped by `customerId`; optional `providerGroupId`) → has many `UserNpi`, `Submission`, Letters
- `UserNpi` (link table, unique `(userId, providerId)`) → assignments powering NPI-based access

Submissions
- `Submission` and `SubmissionDocument`
- `SubmissionEvent` (lifecycle + PCG interaction traces)

 eMDR persistence
- `ProviderListDetail`, `ProviderRegistrationStatus` (authoritative snapshots from PCG)
- Letters: `PrepayLetter`, `PostpayLetter`, `PostpayOtherLetter` with raw payload and normalized columns; `firstViewedAt`

Logging and observability
- `AuditEvent` (tamper-evident, append-only), `AuditEventArchive`
- `ProviderEvent` (business activity log)
- `SecurityEvent` (auth/security sensitive events)
- `AppLog` (structured app logs, optional)

Key constraints/Indexes
- `User.email`, `User.username` unique; `User.customerId`/`providerGroupId` indexed
- `Provider.npi` unique; `Provider.customerId` and `providerGroupId` indexed
- `UserNpi (userId, providerId)` unique
- `PrepayLetter|PostpayLetter|PostpayOtherLetter.externalLetterId` unique; `customerId`, `providerNpi`, `letterDate` indexed
- `AuditEvent` multiple indexes for actor/category/tenant/time lookups

## Security and Compliance Controls

Authentication and sessions
- Login requires username/password; Zod validation and honeypot anti-automation
- TOTP 2FA enforced for users who enable it; 2FA secret stored server-side; verification prior to session issuance
- Force-change flow blocks app access until a strong password is set

Password policy enforcement
- Complexity: 12–24 chars, uppercase, lowercase, digit, special, no leading/trailing whitespace
- Breach/common check via `checkIsCommonPassword`
- Admin “manual reset” sets a strong temp password, invalidates sessions, and sets `mustChangePassword`

Authorization (RBAC)
- Role helpers route users to dashboards and enforce route access
- System-admin–only admin modules (Users, Provider Groups, Providers/NPIs, Letters)

Audit logging (tamper-evident)
- `AuditEvent` implements append-only, hash-chained records per `chainKey`
- Strict size caps for metadata and diff; PHI heuristics to block accidental PHI unless `allowPhi: true`
- Admin actions instrumented across providers and letters

Security events
- `SecurityEvent` captures security-relevant actions (e.g., password reset link sent, manual reset)

Provider events
- `ProviderEvent` captures business actions (create/update/activate/group changes, PCG add attempts/errors)

PHI/data minimization
- Letter sync audit metadata sanitized; raw letter payloads stored in DB but UI emphasizes non-PHI columns
- Audit logging blocks PHI unless explicitly opted-in

Operational safeguards
- Guard rails in admin NPIs and groups prevent misalignment or destructive actions that would orphan data
- First-view timestamps for letters support auditability

## External API Integrations (PCG HIH Wrapper)

Token handling
- All calls go through `callPcg()` which refreshes tokens on 401 once and logs diagnostics on 403

Submissions
- Create: POST `/submission` → `pcgCreateSubmission(payload)`
- Upload files: POST `/submission/{submission_id}` (multipart) → `pcgUploadFiles`
- Get status: GET `/submission/status/{submission_id}` → `pcgGetStatus`
- Update submission: PUT `/updateSubmission/{submission_id}` → `pcgUpdateSubmission`

Providers & eMDR
- List providers: `pcgGetProviders`
- Update provider details: `pcgUpdateProvider`
- Register/deregister eMDR: `pcgSetEmdrRegistration`
- Get registration: `pcgGetProviderRegistration`
- Electronic Only ADR: `pcgSetElectronicOnly`

Letters
- List prepay: POST `/PrePayeMDR`
- List postpay: POST `/PostPayeMDR`
- List postpay (other): POST `/PostPayOthereMDR`
- Download: POST `/getEmdrLetterFileContent`

Error handling patterns
- JSON parsing tolerant; error message propagated when PCG provides a `message`
- Detailed thrown errors include HTTP status and truncated body text

## Page/Module → Tables and Logs Map

Auth
- Tables: `User`, `Password`, `Session`, `Verification`, `SecurityEvent`
- Logs: `SecurityEvent` (reset link, manual reset); Admin audit as applicable

Dashboard
- Tables: `User`, `Role`
- Logs: N/A

Submissions
- Tables: `Submission`, `SubmissionDocument`, `SubmissionEvent`, `UserNpi`, `Provider`
- Logs: `AuditEvent` (via submission service usage), `AppLog` optional

Provider Groups (Admin)
- Tables: `ProviderGroup`, `User`, `Provider`
- Logs: `AuditEvent.ADMIN` for CRUD attempts/outcomes

Provider NPIs (Admin)
- Tables: `Provider`, `ProviderGroup`, `User`, `UserNpi`, `ProviderEvent`
- Logs: `AuditEvent.ADMIN` plus `ProviderEvent`

Provider & eMDR (Admin)
- Tables: `Provider`, `ProviderListDetail`, `ProviderRegistrationStatus`
- Logs: `ProviderEvent` and `AuditEvent`

Letters (Admin)
- Tables: `PrepayLetter`, `PostpayLetter`, `PostpayOtherLetter`, optional links to `Provider`, `Customer`, `ProviderGroup`
- Logs: `AuditEvent.ADMIN`

User Management (Admin)
- Tables: `User`, `Password`, `Role`, `Customer`, `UserNpi`, `SecurityEvent`
- Logs: `SecurityEvent` and `AuditEvent`

## System Admin Tools Overview

- User Management: create users, send reset links, manual resets
- Customer → Provider Groups: CRUD with guard rails
- Customer → Providers/NPIs: CRUD, toggle active, assign/unassign users, bulk operations, group alignment tools
- All Letters: cross-tenant view, filters, per-type sync, PDF view, first-view stamping
- Audit Logs UI: filtered search, integrity tooling, operational maintenance

## Notes and Operational Considerations

- Timezone consistency: display key timestamps in Eastern Time
- `firstViewedAt` stamped once server-side for letters upon first view
- Guard rails prevent risky mutations (e.g., deleting a provider group with assignments)
- Indexes/uniques support responsive UIs and prevent duplicates
- PHI minimization in logs; raw payloads retained in DB for traceability

## Requirements Coverage

- Auth, 2FA, Reset, Logout: Implemented
- Dashboards: Implemented
- Submissions lifecycle with PCG APIs: Implemented
- Provider Groups and NPIs management: Implemented
- Provider & eMDR management: Implemented
- Letters: Implemented
- User Management: Implemented
- Prisma DB modeling: Implemented
- Security features and logging: Implemented

## Appendices

- 2FA Implementation: `2FA-IMPLEMENTATION.md`
- Audit Logging Architecture: `AUDIT_LOGGING.md`
- Page Tables and Guardrails: `PAGE_TABLES_GUARDRAILS.md`
- PCG HIH API wrappers: `app/services/pcg-hih.server.ts`
- Letters sync/download service: `app/services/letters.server.ts`
