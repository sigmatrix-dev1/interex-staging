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
- Assign/Unassign users to provider NPIs
- Bulk user assignment/unassignment with guard rails:
  - If provider has no group: only ungrouped users are eligible
  - If provider has a group: only users in the same group are eligible
  - Block assigning admins to NPIs
  - Block assigning a group to an ungrouped provider when ungrouped users are assigned
- Provider Group alignment banner for quick fixes when user’s group differs from provider’s group
- Drawer-based UX for create/edit; inline popovers for group/user actions

Security/Logging
- Requires `system-admin`
- Audit events (`AuditEvent.ADMIN`) for create/update/toggle-active and assignment attempts
  - Examples: `PROVIDER_CREATE`, `PROVIDER_UPDATE`, `PROVIDER_TOGGLE_ACTIVE`, `PROVIDER_ASSIGN_USER_ATTEMPT`, `PCG_ADD_PROVIDER_NPI`, `PROVIDER_FETCH_REMOTE_NPIS`
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
- `AuditEvent` (tamper-evident, append-only; see Audit Logging), `AuditEventArchive`
- `ProviderEvent` (business activity log around provider management)
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
- `AuditEvent` implements append-only, hash-chained records per `chainKey` (tenant/global)
- Strict size caps for metadata and diff; PHI heuristics to block accidental PHI unless `allowPhi: true`
- Admin actions instrumented across providers and letters; see `AUDIT_LOGGING.md`

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
- List providers: GET `/providers` → `pcgGetProviders`
- Update provider details: PUT `/provider` → `pcgUpdateProvider`
- Register/deregister eMDR: POST `/provider/{provider_id}` with `{ register_with_emdr: boolean }` → `pcgSetEmdrRegistration`
- Get registration state: GET `/provider/{provider_id}` → `pcgGetProviderRegistration`
- Register for Electronic-Only ADR: POST `/provider/ProviderRegistrationForElectronicOnlyADR/{provider_id}` → `pcgSetElectronicOnly`
- Add Provider NPI: POST `/AddProviderNPI` → `pcgAddProviderNpi`
- Org NPIs: GET `/npis` → `pcgGetUserNpis`

Letters
- List prepay: POST `/PrePayeMDR` → `pcgListPrePayLetters`
- List postpay: POST `/PostPayeMDR` → `pcgListPostPayLetters`
- List postpay (other): POST `/PostPayOthereMDR` → `pcgListPostPayOtherLetters`
- Download: POST `/getEmdrLetterFileContent` → `pcgDownloadEmdrLetterFile`

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
- Logs: `AuditEvent.ADMIN` for all CRUD attempts/outcomes

Provider NPIs (Admin)
- Tables: `Provider`, `ProviderGroup`, `User`, `UserNpi`, `ProviderEvent`
- Logs: `AuditEvent.ADMIN` + `ProviderEvent`

Provider & eMDR (Admin)
- Tables: `Provider`, `ProviderListDetail`, `ProviderRegistrationStatus`
- Logs: `ProviderEvent` (business); `AuditEvent` for admin operations

Letters (Admin)
- Tables: `PrepayLetter`, `PostpayLetter`, `PostpayOtherLetter`, optional links to `Provider`, `Customer`, `ProviderGroup`
- Logs: `AuditEvent.ADMIN` (sync/download)

User Management (Admin)
- Tables: `User`, `Password`, `Role`, `Customer`, `UserNpi`, `SecurityEvent`
- Logs: `SecurityEvent` (reset); `AuditEvent` where applicable


## System Admin Tools Overview

- User Management: create users (temp password), send reset links, manual resets; restrict system-admin role creation
- Customer → Provider Groups: CRUD with guard rails
- Customer → Providers/NPIs: CRUD, toggle active, assign/unassign users, bulk operations, group alignment tools
- All Letters: cross-tenant view, filters, per-type sync, PDF view, first-view stamping
- Audit Logs UI (see AUDIT_LOGGING.md): filtered search, integrity tooling, operational maintenance


## Notes and Operational Considerations

- Timezone consistency for letters: display in Eastern Time (tooltips show ISO when applicable)
- `firstViewedAt` stamped once server-side for letters upon first “View” via JSON route
- Guard rails prevent risky mutations (e.g., deleting a provider group with assignments; misaligned user/provider group assignments)
- Indexes/uniques are in place to support lookups and prevent duplicates
- PHI minimization in logs; raw payloads retained in tables for traceability while UIs prefer non-PHI summaries


## Requirements Coverage

- Login/Auth, 2FA, Forgot/Reset, Logout: Implemented
- Dashboard role-based routing: Implemented
- Submissions lifecycle with PCG APIs: Implemented in services; UI entry present
- Provider Group management (CRUD, guard rails): Implemented
- Provider NPI management (CRUD, bulk assignment, guard rails, PCG Add NPI): Implemented
- Provider & eMDR management (registration, provider updates, persisted snapshots): Implemented
- Letters (sync, download/view, first-view stamping, filters): Implemented
- User Management (create, reset link, manual reset, restrictions): Implemented
- Prisma DB modeling (users, roles, customers, providers, submissions, letters, logging): Implemented
- Security features (2FA, password policy, forced change, RBAC, tamper-evident audit): Implemented
- Logs (AuditEvent, ProviderEvent, SecurityEvent, AppLog optional): Implemented


## Appendices

- 2FA Implementation: `2FA-IMPLEMENTATION.md`
- Audit Logging Architecture: `AUDIT_LOGGING.md`
- PCG HIH API wrappers: `app/services/pcg-hih.server.ts`
- Letters sync/download service: `app/services/letters.server.ts`


## Deep-dive reference

### Authentication and sessions

- Cookies
  - Session cookie: `en_session` (httpOnly, sameSite=lax, secure in production, path=/)
    - Storage: `app/utils/session.server.ts` via `createCookieSessionStorage`
    - Commit wrapper preserves a persistent `expires` across commits to avoid involuntary session shortening.
  - Verification cookie: `en_verification` (httpOnly, sameSite=lax, secure in production, path=/, maxAge 10 minutes)
    - Storage: `app/utils/verification.server.ts`
    - Used for short-lived verification flows (e.g., password reset OTP/link).

- Session lifecycle
  - Create session: `auth.server.ts -> prisma.session.create()` with `expirationDate = now + 30 days`.
  - Validate session: `getUserId()` reads cookie, loads session, ensures not expired and user is still active; otherwise destroys cookie and redirects.
  - Logout: `logout()` destroys cookie, deletes session row, writes audit event `AUTH/LOGOUT`.

- Login flow (high-level)
  1. User submits username/password to `/auth/login` action.
  2. `verifyUserPassword()` checks bcrypt hash and `User.active`.
  3. If credentials valid and 2FA is enabled for the user, redirect to `/auth/2fa` with the pending context.
  4. On 2FA page, user enters a TOTP code which is verified server-side using the stored `User.twoFactorSecret`.
  5. On success, create session and redirect to target (default dashboard by role).
  6. On failure, log `LOGIN_FAILURE` audit with reason; do not reveal user existence.

- 2FA
  - User fields: `User.twoFactorSecret` (opaque), `User.twoFactorEnabled` (boolean).
  - Setup: `/me/2fa` generates a TOTP secret/QR; user confirms by entering code; server verifies before enabling.
  - Login step-up: `/auth/2fa` prompts for code after password validation.

- Forced password change
  - `User.mustChangePassword` (boolean) gates access until a compliant password is set.
  - `change-password` route enforces policy and updates `passwordChangedAt`.

- Password policy (`app/utils/password-policy.server.ts`)
  - 12–24 characters.
  - Must include: uppercase, lowercase, digit, special.
  - No leading/trailing whitespace.
  - Optional breach check: `checkIsCommonPassword()` (k-anonymity via HaveIBeenPwned range API, 1s timeout, soft-fail).

- RBAC and redirects
  - Primary roles supported: `system-admin`, `customer-admin`, `provider-group-admin`, `basic-user`.
  - Helpers: `app/utils/role-redirect.server.ts`
    - `getPrimaryRole()` determines highest-authority role.
    - `getDashboardUrl()` maps role → dashboard: `/admin/dashboard`, `/customer`, `/provider`, `/customer/submissions`.
    - `requireRoles()` redirects when not authorized.


### Submissions: Flow and payloads

- Create submission flow (service-level)
  1. Map UI form to PCG payload with `buildCreateSubmissionPayload()`:
     - Maps `purposeOfSubmission` to PCG `purpose_of_submission` codes via `PURPOSE_MAP`.
     - Payload fields: `author_npi`, `author_type`, `name`, `esMD_claim_id`, `esmd_case_id`, `comments`, `intended_recepient`, `auto_split`, `bSendinX12`, `threshold`, and `document_set[]` with `{ name, split_no, filename, document_type: 'pdf', attachmentControlNum }`.
  2. Call `pcgCreateSubmission(payload)` → returns `{ submission_id, submission_status, errorList? }`.
  3. Upload files: `pcgUploadFiles(submission_id, files[])` multipart under key `uploadFiles`.
  4. Poll status: `pcgGetStatus(submission_id)` → returns `status`, `stage`, `statusChanges[]`, etc.
  5. Update submission: `pcgUpdateSubmission(submission_id, payload)` if necessary.

- Status mapping
  - `coerceStageToLocalStatus(stage)` → `SUBMITTED | PROCESSING | COMPLETED` (heuristic mapping of PCG stage text).

- Error handling pattern (PCG calls)
  - On non-2xx, attempt JSON parse; if `{ message }` exists, throw that, else throw `Error("{fn} failed (status): truncated body")`.
  - `callPcg()` (in token service) refreshes token once on 401, logs diagnostics on 403.

- Key types (from `app/services/pcg-hih.server.ts`)
  - Create: POST `/submission` → `{ submission_id: string; submission_status: string; errorList?: any[] }`.
  - Upload: POST `/submission/{id}` → same shape as create.
  - Status: GET `/submission/status/{id}` → `{ status, stage?, esmdTransactionId?, statusChanges?[] }`.

- Database
  - `Submission` holds local lifecycle and PCG identifiers.
  - `SubmissionDocument` tracks uploaded documents with `uploadStatus`.
  - `SubmissionEvent` logs integration steps and statuses.


### Provider and NPI management (Admin)

- Provider Groups (`admin+/customer-manage.$customerId.provider-groups.tsx`)
  - CRUD with validations:
    - Unique per-customer: `(customerId, name)`.
    - Deletion blocked if users or providers are assigned.
  - Audit events (category `ADMIN`):
    - `PROVIDER_GROUP_CREATE(_ATTEMPT)`, `PROVIDER_GROUP_UPDATE(_ATTEMPT)`, `PROVIDER_GROUP_DELETE(_ATTEMPT|_BLOCKED)`, `PROVIDER_GROUP_NAME_CONFLICT`, `PROVIDER_GROUP_NOT_FOUND`.

- Provider NPIs (`admin+/customer-manage.$customerId.providers.tsx`)
  - CRUD + activation toggle.
  - Assign/unassign users to NPIs with guard rails:
    - If provider has no group → only ungrouped users eligible.
    - If provider has a group → only users in that group eligible.
    - Admins cannot be assigned to NPIs.
    - Prevent setting a group on a provider when currently assigned users are ungrouped (or vice versa) until resolved.
  - PCG integration:
    - `pcgAddProviderNpi({ providerNPI, customerName })` tolerates duplicates (treated as success upstream).
    - `pcgGetUserNpis()` lists org-registered NPIs.
  - Events:
    - `ProviderEvent` kinds: CREATED, UPDATED, ACTIVATED, INACTIVATED, GROUP_ASSIGNED, GROUP_UNASSIGNED, PCG_ADD_ATTEMPT, PCG_ADD_ERROR.
  - Audit: Attempts and outcomes logged under `ADMIN`.

- Providers & eMDR (`app/services/pcg-hih.server.ts` + admin route `providers-emdr-management.tsx`)
  - List providers: `pcgGetProviders({ page?, pageSize? })` → `PcgProviderListResponse` with fields like `providerNPI`, `registered_for_emdr`, `stage`, `reg_status`, address lines, etc.
  - Update provider: `pcgUpdateProvider({ provider_name, provider_npi, provider_street, ... })` → `{ provider_status, provider_id }`.
  - eMDR register/deregister: `pcgSetEmdrRegistration(provider_id, boolean)`.
  - Electronic-only ADR: `pcgSetElectronicOnly(provider_id)`.
  - Persisted snapshots per provider:
    - `ProviderListDetail` (fields include NPI, pcgProviderId, reg flags, address, statusChanges/notificationDetails JSON blobs).
    - `ProviderRegistrationStatus` (registration state, errors, address, statusChanges JSON).


### Letters: Sync and Download details

- List API wrappers
  - Prepay: POST `/PrePayeMDR` → `{ prepayeMDRList?: any[], totalResultCount? }`.
  - Postpay: POST `/PostPayeMDR` → payload may vary key: `postpayeMDRList` or `postPayeMDRList`.
  - Postpay (Other): POST `/PostPayOthereMDR` → `{ otherPostPayEMDRList?: any[] }`.

- Normalization and persistence (`app/services/letters.server.ts`)
  - NPI normalization: extract first 10-digit sequence from multiple candidate fields; fallback to `UNKNOWN` if unavailable.
  - Date parsing: accept `MM/DD/YYYY` and ISO-like strings; stored as UTC Date.
  - externalLetterId: choose from `letterID` or `eMDRMetaData.uniqueLetterId|uniqueLetterID` (stringified), MUST be present to upsert.
  - downloadId:
    - PREPAY: `eMDRPrePayID`.
    - POSTPAY: `eMDRPostPayID`.
    - POSTPAY_OTHER: `otherPostPayEMDRId`.
    - For older rows missing `downloadId`, derive at download time from `raw` with a case-insensitive key map and backfill once.
  - Provider/customer linkage: find `Provider` by NPI to populate `providerId`, `customerId`, `providerGroupId` foreign keys.
  - First-view stamping: `firstViewedAt` is set server-side the first time a letter is opened.

- Download flow
  1. Lookup letter by `externalLetterId` in the type’s table.
  2. Resolve `downloadId` (existing or derived from `raw`, then persisted if missing).
  3. Call `pcgDownloadEmdrLetterFile({ letter_id: downloadId, letter_type })` → `{ file_content?: base64 }`.
  4. Return `{ fileBase64, filename }` to client; open in a new tab.

- UI behaviors
  - Global filter (customer, search), per-type sync, and “days left” chips based on `respondBy`.
  - Timestamps are displayed in ET for consistent operational review (ISO tooltip as needed).

- Logging
  - Audit events (category `ADMIN`): `LETTERS_SYNC`, `LETTER_DOWNLOAD` with sanitized metadata (PHI-minimized).


### Audit, Security, and App logs

- AuditEvent (tamper-evident)
  - See `AUDIT_LOGGING.md` for full spec.
  - Core fields: `chainKey`, `seq`, `hashPrev`, `hashSelf`, `category`, `action`, `status`, `actorType/Id`, `entityType/Id`, `requestId/traceId/spanId`, `summary`, `metadata(≤2KB)`, `diff(≤4KB)`, `phi`.
  - Helpers: `app/services/audit.server.ts` provides category-specific functions `audit.auth`, `audit.submission`, `audit.system`, `audit.admin`, etc.

- SecurityEvent
  - Fields: `kind`, `message?`, `userId?`, `userEmail?`, `customerId?`, `ip?`, `userAgent?`, `requestId?`, `success`, `reason?`, `data?`.
  - Used for password reset link sends, manual resets, and other security-sensitive actions.

- AppLog (optional structured logs)
  - Useful for HTTP/perf traces and UI-level events; indexed by module/event.


### External API catalog (PCG HIH)

- Submissions
  - POST `/submission` → create; body from `buildCreateSubmissionPayload()`.
  - POST `/submission/{submission_id}` (multipart, key `uploadFiles`) → upload.
  - GET `/submission/status/{submission_id}` → poll status.
  - PUT `/updateSubmission/{submission_id}` → update.

- Providers & eMDR
  - GET `/providers` → list with pagination.
  - PUT `/provider` → update provider details by NPI.
  - POST `/provider/{provider_id}` `{ register_with_emdr: boolean }` → register/deregister.
  - GET `/provider/{provider_id}` → get registration.
  - POST `/provider/ProviderRegistrationForElectronicOnlyADR/{provider_id}` → set electronic-only ADR.
  - POST `/AddProviderNPI` `{ providerNPI, customerName }` → add NPI.
  - GET `/npis` → org-registered NPIs.

- Letters
  - POST `/PrePayeMDR`, `/PostPayeMDR`, `/PostPayOthereMDR` → list by date range (`page`, `startDate`, `endDate`).
  - POST `/getEmdrLetterFileContent` `{ letter_id, letter_type }` → base64 PDF.

- Token handling
  - All calls wrapped by `callPcg()` which handles token refresh on 401 once and emits diagnostics on 403.


### Database: Key models and constraints (selected)

- Identity and auth
  - `User`: `email` unique, `username` unique, `active`, soft-delete `deletedAt`; 2FA fields; policy fields (`mustChangePassword`, `passwordChangedAt`).
  - `Password`: one-to-one with `User`.
  - `Session`: `expirationDate`, foreign key to `User`.
  - `Verification`: unique `(target, type)`, stores OTP/link material and expiry for verification flows.
  - `Role`, `Permission`: RBAC with many-to-many.
  - `Passkey`: reserved for WebAuthn support (not surfaced in UI yet).

- Tenancy and providers
  - `Customer`: optional `baaNumber` unique; cascades to children on delete.
  - `ProviderGroup`: unique `(customerId, name)`; has many `User` and `Provider`.
  - `Provider`: global unique `npi`; belongs to `Customer`; optional `providerGroupId`.
  - `UserNpi`: unique `(userId, providerId)`; drives NPI-based access.

- Submissions
  - `Submission`: unique `pcgSubmissionId`; indexed by `creatorId`, `providerId`, `customerId`, `status`, `purposeOfSubmission`.
  - `SubmissionDocument`: file metadata and upload status; links to `Submission` and `User`.
  - `SubmissionEvent`: enumerated `kind` capturing integration steps.

- eMDR persistence
  - `ProviderListDetail`, `ProviderRegistrationStatus`: one-to-one with `Provider` by `providerId` (unique), latest snapshot semantics.
  - Letters tables: `PrepayLetter`, `PostpayLetter`, `PostpayOtherLetter` with `externalLetterId` unique and `downloadId?`; optional FKs to `Provider`, `Customer`, `ProviderGroup`.

- Logging
  - `AuditEvent` and `AuditEventArchive`: append-only, hash chained; multiple indices for common queries.
  - `SecurityEvent`, `AppLog`, `ProviderEvent` for security, app telemetry, and provider domain actions.


### Operational and compliance notes

- PHI minimization
  - Audit writes enforce PHI heuristics; set `allowPhi: true` only with justification.
  - Letters UI emphasizes non-PHI summary fields; raw payloads retained in DB for traceability.

- Timezone
  - Operational UIs (e.g., Audit Logs, Letters) render critical timestamps in ET for consistency; ISO available on hover/tooltips.

- Indexing and performance
  - Ensure critical filters (customer, providerNpi, letterDate, createdAt) use existing indices for responsive UIs.

- Env configuration (selected)
  - `SESSION_SECRET` (comma-separated list) – cookie signing secrets.
  - `DATABASE_URL` – SQLite/LiteFS path.
  - PCG env: base URL and credentials used by `pcg-token.server.ts` and `PCG_ENV`.

- Testing
  - Playwright coverage under `tests/` for auth and flows; audit tests described in `AUDIT_LOGGING.md` (unit/integration).


### Example sequences

- Login with 2FA
  1) POST /auth/login (username/password) → validate credentials.
  2) If `twoFactorEnabled`, redirect to GET /auth/2fa.
  3) POST /auth/2fa (6-digit TOTP) → verify; on success create session and redirect to role dashboard.

- Letters sync + view
  1) Admin triggers sync for PREPAY in date range.
  2) Service paginates through PCG list; normalizes and upserts rows; writes `LETTERS_SYNC` audit.
  3) User clicks View on a row → server resolves `downloadId` (derive + backfill if missing), calls download API, stamps `firstViewedAt`, streams PDF.

- Provider NPI assignment
  1) Admin opens Provider drawer; adjusts group or toggles active.
  2) Assigns user to NPI: validations enforce group alignment and non-admin users only.
  3) Writes `ProviderEvent` and `AuditEvent.ADMIN` reflecting the outcome.

