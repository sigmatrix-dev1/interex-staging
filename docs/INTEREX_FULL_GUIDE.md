# InterEx: Complete Guide and System Overview

Last updated: 2025-09-27

This single document consolidates all key information about the InterEx application. It is the go-to reference for product owners, engineers, and operators to understand the platform end-to-end: what it does, how it’s built, how to operate it safely, and how to extend it.

- Audience: Engineering, Product, and Operations
- Scope: Features, roles, UX flows, APIs, DB schema, security, logging, operations, testing

---

## Table of Contents

- [1) Product Overview](#1-product-overview)
- [2) Architecture at a Glance](#2-architecture-at-a-glance)
	- [2.1) Local Setup and Running](#21-local-setup-and-running)
	- [2.2) Environment variables (reference)](#22-environment-variables-reference)
- [3) Security and Access Controls](#3-security-and-access-controls)
- [4) Modules and User Flows](#4-modules-and-user-flows)
	- [4.1 Authentication and Account Management](#41-authentication-and-account-management)
	- [4.2 Submissions](#42-submissions)
		- [4.2.1 Step 1 — New Submission](#421-step-1--new-submission-metadata--split--documents)
		- [4.2.2 Step 2 — Review/Update](#422-step-2--reviewupdate)
		- [4.2.3 Step 3 — Upload](#423-step-3--upload)
	- [4.3 Providers, NPIs, Groups (Admin)](#43-providers-npis-groups-admin)
	- [4.4 Letters (Admin)](#44-letters-admin)
	- [4.5 Role-based Page Map (what each role sees)](#45-role-based-page-map-what-each-role-sees)
- [5) Database Model Overview](#5-database-model-overview)
	- [5.1) Folder Structure Quick Map](#51-folder-structure-quick-map)
- [6) External Integrations (PCG HIH)](#6-external-integrations-pcg-hih)
- [7) Logging and Observability](#7-logging-and-observability)
- [8) UI and UX Standards](#8-ui-and-ux-standards)
- [9) Operations and Runbooks](#9-operations-and-runbooks)
- [10) Testing Strategy](#10-testing-strategy)
- [11) Page Catalog: Tables, Columns, Actions, Guardrails](#11-page-catalog-tables-columns-actions-guardrails)
- [12) Security Appendix (2FA)](#12-security-appendix-2fa)
- [13) Glossary](#13-glossary)
- [14) Roadmap and Deferred Items](#14-roadmap-and-deferred-items)
- [15) Quick Links](#15-quick-links)
- [16) RBAC Matrix (Summary)](#16-rbac-matrix-summary)
- [17) Troubleshooting](#17-troubleshooting)
- [Appendix: Full Source Documents](#appendix-full-source-documents)
	- [A. InterEx Technical Specification (full)](#a-interex-technical-specification-full)
	- [B. Audit Logging Architecture (full)](#b-audit-logging-architecture-full)
	- [C. Page Tables, Columns, Actions, Guardrails (full)](#c-page-tables-columns-actions-guardrails-full)
	- [D. 2FA Implementation Summary (full)](#d-2fa-implementation-summary-full)
	- [E. Documentation Migration Notes (full)](#e-documentation-migration-notes-full)

## 1) Product Overview

InterEx streamlines healthcare submissions to CMS/PCG, manages provider NPIs and eMDR registrations, and centralizes letters management, all with strong guardrails and auditability. It’s a multi-tenant, role-secured, web-based platform.

Primary modules:
- Authentication and Account Security (2FA, password policy, forced change)
- Submissions lifecycle with PCG integration (create, update, upload, status)
- Providers & NPIs (CRUD, assignments, group alignment)
- eMDR registration management and provider updates
- Letters (Prepay, Postpay, Other) with sync, view, and first-view stamping
- Admin tools and audit logging

Roles:
- System Admin, Customer Admin, Provider Group Admin, Basic User

---

## 2) Architecture at a Glance

- Frontend: Remix + React + TypeScript, Tailwind CSS
- Forms: Zod + Conform
- Server: Node 22, Express entry with React Router server adapter
- Database: Prisma (SQLite/LiteFS in production), migrations under `prisma/migrations`
- Integrations: PCG HIH Wrapper APIs for submissions, providers, and letters
- Observability: AuditEvent (tamper-evident), SecurityEvent, ProviderEvent, optional AppLog
- Testing: Vitest + Playwright

Key code locations:
- Routes: `app/routes/**`
- Services: `app/services/**`
- Domain enums/helpers: `app/domain/**`
- Styles: `app/styles/tailwind.css` (includes global table styling)
- Prisma schema: `prisma/schema.prisma`

---

## 2.1) Local Setup and Running

Prereqs
- Node.js 22 (see `package.json` engines)
- SQLite (bundled), Git

Steps
1) Create a `.env` from `.env.example` and set secrets (at minimum set `SESSION_SECRET`). PCG values can remain mock for local UI runs.
2) Install dependencies and prepare the project:
	- `npm install`
	- `npm run setup` (builds app, runs Prisma migrate deploy, generates client, installs Playwright)
3) Start the dev server: `npm run dev` (mock mode enabled by default)

Useful scripts
- Typecheck: `npm run typecheck`
- Build (prod): `npm run build`
- Start (prod): `npm start`
- E2E (headed UI): `npm run test:e2e:dev`

Database seeding
- Seeds are available in `prisma/seed-sigmatrix.ts` (configured in `package.json` → `prisma.seed`). To seed: `npx prisma db seed`

Environment variables (selected) — see `.env.example`
- Core: `DATABASE_URL`, `SESSION_SECRET`, `HONEYPOT_SECRET`
- Storage (optional): S3-compatible `AWS_*` and `BUCKET_NAME`
- PCG: `PCGF_*` values for token and API base URL

---

## 2.2) Environment variables (reference)

Copy `.env.example` to `.env` and adjust as needed.

- Core
	- `SESSION_SECRET` — required for session signing
	- `DATABASE_URL` — defaults to `file:./prisma/data.db` (SQLite)
	- `HONEYPOT_SECRET` — spam protection secret for forms
- PCG HIH
	- `PCGF_CLIENT_ID`, `PCGF_CLIENT_SECRET` — OAuth client
	- `PCGF_TOKEN_URL`, `PCGF_API_BASE` — token and API endpoints
- Storage (optional)
	- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `S3_ENDPOINT`, `BUCKET_NAME`
- Sentry (optional)
	- `SENTRY_DSN`, `SENTRY_ENVIRONMENT`

Tip: For local development, a `MOCKS=true` flag can enable mock responses in dev workflows.

---

## 3) Security and Access Controls

- 2FA: Time-based OTP using `@epic-web/totp`; required for users who enable it; enforcement during login
- Password policy: 12–24 chars, mixed character classes, breach/common password check
- Forced password change: Gate access until a compliant password is set when flagged
- RBAC: Role checks at route boundaries; requires authentication for protected routes
- PHI minimization: Strict audit logging heuristics; explicit opt-in required to log PHI
- Session management: HttpOnly cookies; expiration and destruction on logout or admin resets

### Sessions UI (Active Sessions)

- Location: Profile → Active Sessions
- Features:
	- List all active sessions for the signed-in user, including:
		- Device label with icon (phone for mobile UAs, laptop for desktop)
		- Browser and OS summary (e.g., “Chrome 140 on macOS 10.15”)
		- Signed in timestamp in Eastern Time with timezone label (EST/EDT)
		- Last active timestamp (derived from session activity)
		- IP address display following privacy mode
	- Actions:
		- Per-session Sign out to revoke a specific device
		- “Sign Out Other Sessions” to log out everywhere else
- Privacy modes for IP (configure via environment):
	- `LOG_IP_MODE=raw` — store/show full IP
	- `LOG_IP_MODE=masked` — store/show masked IP (/24 for IPv4, /48 for IPv6)
	- `LOG_IP_MODE=hash` — store/show salted SHA-256 hash (set `IP_HASH_SALT`)
- Notes:
	- In local dev without proxy headers, IP may appear as “Unknown IP”. In production (Fly/Cloudflare), IP is taken from `fly-client-ip` or `cf-connecting-ip` (fallback to first `x-forwarded-for`).

See: 2FA Implementation (full content included below in Appendix) and sections below

---

## 4) Modules and User Flows

### 4.1 Authentication
- Login with username/password; honeypot protection and Zod validation
- If user has 2FA enabled, the flow redirects to /auth/2fa to verify a TOTP code before issuing a session
- Forgot/Reset: Users can request a reset link/OTP; admins can send reset links or perform manual resets (with forced change on next login)
- Change Password: Users flagged must complete change before accessing the app

Important routes:
- `_auth+/login.tsx`, `_auth+/2fa.tsx`, `me.2fa.tsx`, `_auth+/forgot-password.tsx`, `change-password.tsx`, `_auth+/logout.tsx`

Tables: `User`, `Password`, `Session`, `Verification`, `SecurityEvent`

### 4.2 Submissions
- Create → Review/Update → Upload → Track status
- Payloads mapped to PCG using `buildCreateSubmissionPayload()`; events tracked in `SubmissionEvent`
- Status snapshots applied back to the local DB to keep fields in sync

Key services: `pcgCreateSubmission`, `pcgUploadFiles`, `pcgGetStatus`, `pcgUpdateSubmission`

Tables: `Submission`, `SubmissionDocument`, `SubmissionEvent`, relations to `User`, `Provider`

#### 4.2.1 Step 1 — New Submission (Metadata + Split + Documents)
- Fields: `title`, `authorType`, `purposeOfSubmission`, `recipient` (OID), `providerId` (NPI), `claimId`, `caseId` (≤ 32 chars), `comments`, `sendInX12`, `threshold`.
- Split: `splitKind` (manual/auto). Derived flags: `autoSplit`; `docCount` required for manual (1..99).
- Documents: `name`, `filename` (.pdf), `attachmentControlNum` (ACN), `split_no` (derived), `document_type='pdf'`.
- Guardrails
	- RBAC scope: System → all; Customer → own; Group → own group; Member → assigned NPIs.
	- Recipient must be valid for the selected purpose; server revalidates.
	- File rules: PDF only; per-file and total size limits (see `#app/utils/upload-constraints.ts`).
- Outcome
	- Creates local Submission (status=DRAFT), sends payload to PCG, records `DRAFT_CREATED`, `PCG_CREATE_*` events, snapshots PCG status, and redirects to Step 2 with draft nonce for file cache transfer.

#### 4.2.2 Step 2 — Review/Update
- Loader refreshes PCG snapshot once per load; creates `PCG_STATUS` event and overwrites local fields from PCG (title, claimId, caseId, authorType, autoSplit, comments, recipient, purpose mapping, `transactionId`, `responseMessage`).
- Edits: title, authorType, purpose, recipient, NPI, claim/case, comments, sendInX12, threshold, split/doc metadata.
- Guardrails
	- Only DRAFT submissions are editable; otherwise redirect back with a toast.
	- Recipient again validated for selected purpose; RBAC enforced on chosen NPI.
	- Per-file and total size limits enforced client-side and server-side.
- Outcome
	- Sends `pcgUpdateSubmission`; on success stores `META_UPDATED`, `PCG_UPDATE_SUCCESS`. Action does not re-fetch PCG; loader refreshes on next load.

#### 4.2.3 Step 3 — Upload
- Upload the prepared files; server associates each file with `split_no` and document metadata.
- Guardrails: PDF and size validations; required metadata; retries surface errors and preserve state.
- Events: upload results logged; status/transaction IDs updated from PCG status.

Related constants: `BYTES_PER_MB`, `MAX_TOTAL_MB`, `perFileLimitFor(splitKind)`, `totalsNoteFor(splitKind)` in `app/utils/upload-constraints.ts`.

### 4.3 Providers, NPIs, Groups (Admin)
- Provider Groups: CRUD with delete guardrails when linked users/providers exist
- Provider NPIs: CRUD, toggle active, assign/unassign users with group-alignment rules
- Providers & eMDR: Fetch from PCG, update details, manage registration states including Electronic-Only ADR

Tables: `Customer`, `ProviderGroup`, `User`, `Provider`, `UserNpi`, `ProviderEvent`, `ProviderListDetail`, `ProviderRegistrationStatus`

### 4.4 Letters (Admin)
- Sync by type and date range; view and stamp first-view on open
- Columns emphasize non-PHI fields; raw payload retained in DB

Tables: `PrepayLetter`, `PostpayLetter`, `PostpayOtherLetter`

---

### 4.5 Role-based Page Map (what each role sees)

This index lists the real pages by role and links to their detailed entries in the Page Catalog below.

Role — System Admin
1. Dashboard
2. Reports — see Admin → Reports (`app/routes/admin+/reports.tsx`)
3. Users — see Admin → Users (`app/routes/admin+/users.tsx`)
4. Manage Customer — overview and sub-pages
	- Overview — Admin → Customer Manage Overview (`app/routes/admin+/customer-manage.$customerId.tsx`)
	- Users — Admin → Customer Manage → Users (`app/routes/admin+/customer-manage.$customerId.users.tsx`)
	- Providers — Admin → Customer Manage → Providers (`app/routes/admin+/customer-manage.$customerId.providers.tsx`)
	- Provider Groups — Admin → Customer Manage → Provider Groups (`app/routes/admin+/customer-manage.$customerId.provider-groups.tsx`)
5. New Customer — Admin → Customers and New Customer (`app/routes/admin+/customers.tsx`, `app/routes/admin+/customers.new.tsx`)
6. Organization — Admin tools
	- Audit Logs (`app/routes/admin+/audit-logs.tsx`)
	- Audit Maintenance (`app/routes/admin+/audit-maintenance.tsx`)
	- Notifications Maintenance (`app/routes/admin+/notifications.tsx`)
7. Provider — Providers eMDR Management (`app/routes/admin+/providers-emdr-management.tsx`)
8. Letters — All Letters (`app/routes/admin+/all-letters.tsx`)

Role — Customer Admin
1. Dashboard
2. Organization
	- Provider Groups (`app/routes/customer+/provider-groups.tsx`)
	- Users (`app/routes/customer+/users.tsx`)
3. Provider
	- Provider NPIs (`app/routes/customer+/provider-npis.tsx`)
	- Providers & eMDR (scoped) (`app/routes/providers-emdr.tsx`)
4. Submissions (`app/routes/customer+/submissions.tsx`)
5. Letters (`app/routes/customer+/letters.tsx`)

Role — Provider Group Admin
1. Dashboard
2. Organization
	- Users (scoped to their group) (`app/routes/customer+/users.tsx`)
3. Provider
	- Provider NPIs (`app/routes/customer+/provider-npis.tsx`)
	- Providers & eMDR (scoped) (`app/routes/providers-emdr.tsx`)
4. Submissions (`app/routes/customer+/submissions.tsx`)
5. Letters (`app/routes/customer+/letters.tsx`)

Role — Basic User
1. Dashboard (TBD — not yet implemented)
2. Provider
	- My NPIs (`app/routes/my-npis.tsx`)
	- Provider NPIs (scoped) (`app/routes/customer+/provider-npis.tsx`)
	- Providers & eMDR (scoped) (`app/routes/providers-emdr.tsx`)
3. Submissions (`app/routes/customer+/submissions.tsx`)
4. Letters (`app/routes/customer+/letters.tsx`)

See Section 11 for per-page tables, actions, and guardrails.

## 5) Database Model Overview

- Identity: `User`, `Password`, `Session`, `Verification`, `Role`, `Permission`, `Passkey`
- Tenancy and Providers: `Customer`, `ProviderGroup`, `Provider`, `UserNpi`
- Submissions: `Submission`, `SubmissionDocument`, `SubmissionEvent`
- eMDR persistence: `ProviderListDetail`, `ProviderRegistrationStatus`; letters tables per type
- Logging: `AuditEvent`, `AuditEventArchive`, `ProviderEvent`, `SecurityEvent`, optional `AppLog`

Constraints and indexes:
- Unique: `User.email`, `User.username`, `Provider.npi`, `UserNpi(userId, providerId)`, letters `externalLetterId`
- Indexed: common filters (customerId, providerGroupId, providerId, createdAt, letterDate, status)

---

## 5.1) Folder Structure Quick Map

Top-level
- `app/` — Remix app (routes, components, services, utils)
- `server/` — dev/prod server entry
- `prisma/` — schema, migrations, seeds, dev DB
- `public/` — static assets
- `other/` — build scripts, Docker/LiteFS configs
- `docs/` — all documentation

Inside `app/`
- `routes/` — feature modules and pages
- `components/` — shared UI (forms, drawer, table styles)
- `services/` — PCG wrappers, audit, letters
- `domain/` — enums and mappings (submissions)
- `styles/` — Tailwind layer with global table styling

---

## 6) External Integrations (PCG HIH)

- Submissions APIs: create, upload, status, update
- Providers APIs: list and update; eMDR register/deregister; get registration; set Electronic-Only ADR; add provider NPI; list org NPIs
- Letters APIs: list per type; download file content
- Token handling: Wrapper refreshes tokens on 401 once; captures diagnostics on 403

See: `app/services/pcg-hih.server.ts`

Contract summary
- Create: Build payload via `buildCreateSubmissionPayload` (maps local enums/flags to PCG keys like `auto_split`, `bSendinX12`). Expects `{ submission_id }` on success.
- Update: Use the same builder; `pcgUpdateSubmission` applies metadata changes.
- Status: `pcgGetStatus(submission_id)` returns a snapshot; we map to local fields and record `PCG_STATUS`.

Normalization helpers
- Transaction IDs: may return `esmdTransactionId` or string lists (`transactionIdList`/`uniqueIdList`). We normalize to `Submission.transactionId`.
- Recipient OIDs: values may be like `urn:oid:<value>`; normalized to `<value>`.
- Purpose mapping: PCG `contentType` codes map to local enum (e.g., '1' → ADR, '7' → PWK_CLAIM_DOCUMENTATION, '9' → FIRST_APPEAL, '9.1' → SECOND_APPEAL).

---

## 7) Logging and Observability

- AuditEvent: Tamper-evident hash-chained logs per tenant; helpers under `app/services/audit.server.ts`
- SecurityEvent: Security-sensitive events (reset link/manual reset)
- ProviderEvent: Business activity log for provider domain
- AppLog (optional): Structured logs for telemetry

UI: `/admin/audit-logs` with filters, cursor pagination, EST timestamping, JSON expanders

See: Audit Logging Architecture (full content included below in Appendix)

Event catalog (Submissions)
- `DRAFT_CREATED` — payload audit of the metadata we sent (local)
- `META_UPDATED` — payload audit of updated metadata (local)
- `PCG_CREATE_SUCCESS` / `PCG_CREATE_ERROR` — outcome of remote create
- `PCG_UPDATE_SUCCESS` / `PCG_UPDATE_ERROR` — outcome of remote update
- `PCG_STATUS` — snapshot from PCG taken on load or explicit refresh
- `STATUS_UPDATED` — bookkeeping audit when statuses change

---

## 8) UI and UX Standards

- Tables: Consistent header styling (dark blue with white text), borders, subtle radius and shadow, and darker row hover states for focus; all implemented globally in `app/styles/tailwind.css`
- Drawers and popovers for actions to prevent accidental destructive changes
- Back guard banners for admin areas to discourage unwanted back navigation
 - Use the component-layer classes for tables to ensure consistent borders, header styling, and shadows across pages.

---

## 9) Operations and Runbooks

- Environment config highlights: `SESSION_SECRET`, `DATABASE_URL`, PCG credentials
- Setup: `npm run setup` (build, migrate, generate, install Playwright)
- Build: `npm run build`; Typecheck: `npm run typecheck`; Start: `npm start`
- Database migrations: under `prisma/migrations`; use `prisma migrate dev` for local changes
- Audit verification: Use `verifyAllChains()` periodically; investigate any mismatches
- Export audit logs: Server export endpoint available; UI export can be re-enabled as needed

Deployment overview
- The repo includes `fly.toml`, `litefs.yml`, and a Dockerfile for Fly.io deployments with LiteFS for SQLite replication.
- Build server entry: `other/build-server.ts` produces `server-build/` for production.
- Use `npm run build` during image build; run DB migrations (`prisma migrate deploy`) on release.

Secrets rotation
- Rotate `SESSION_SECRET` and PCG credentials periodically; redeploy with updated secrets and verify sign-in + submission flows.

---

## 10) Testing Strategy

- Unit tests via Vitest; Playwright for e2e
- Audit-specific tests validate canonical JSON and hash continuity
- Mocking: MSW for network where applicable; optional MOCKS flag for dev

---

## 11) Page Catalog: Tables, Columns, Actions, Guardrails

See Page Tables and Guardrails (full content included below in Appendix) for the live, page-by-page breakdown.

Highlights:
- Admin → Users, Provider Groups, Provider NPIs with robust delete/assignment guardrails
- Providers & eMDR operations with preconditions and confirmation gates
- Letters lists per type with ET date consistency and first-view stamping

### Admin → Reports
- Path: `/admin/reports` (`app/routes/admin+/reports.tsx`)
- Purpose: System Admin reporting hub for submissions, letters, eMDR, NPIs, security/compliance
- Features
	- Date range parsing supports date-only (YYYY-MM-DD) and full ISO; normalizes to local day start/end
	- Per-section exports; formats include CSV (default) and others as configured
	- CSV generation deduplicates headers across rows and escapes safely
	- Customer filter; section switcher via `exportSection`
- Guardrails
	- Requires System Admin

### Admin → Users (User Management)
- Path: `/admin/users` (`app/routes/admin+/users.tsx`)
- Actions (intents)
	- Create user: intent `create` (email, username, name, customer, role, active)
	- Send reset link: intent `send-reset-link` (10-minute OTP link)
	- Manual reset: intent `manual-reset` (strong temp password; invalidates sessions)
	- Reset 2FA: intent `reset-2fa` (disables 2FA, clears secret; audited)
- Guardrails
	- Requires System Admin; protected loaders/actions
	- Clean separation of intents via discriminated Zod union
	- 2FA reset logs security/audit events; sessions invalidated on manual reset

### Admin → Customer Manage (Overview)
- Path: `/admin/customer-manage/:customerId` (`app/routes/admin+/customer-manage.$customerId.tsx`)
- Purpose: One-stop overview of the selected customer with users, groups, and providers
- Guardrails: System Admin only; 404/401 on missing access or customer

### Admin → Customer Manage → Users (User Management)
- Path: `/admin/customer-manage/:customerId/users` (`app/routes/admin+/customer-manage.$customerId.users.tsx`)
- Table columns: Name, Email, Username, Roles, Status, Actions, Reset, Assign NPIs
- Actions
	- Create/Update user (drawers)
	- Reset password (auto/manual)
	- Assign NPIs (drawer with selection)
	- Deactivate and Unassign (atomic): clears `userNpi`, sets inactive, deletes sessions
	- Delete user (hard delete) with dependency and safety checks
- Guardrails
	- Prevent delete of System Admins, self, and last Customer Admin
	- Delete blocked when dependents exist (submissions, docs, provider events); returns `deleteBlocked` counts
	- Debounced availability checks for email/username; username regex and length enforced
	- Full audit trail for lifecycle and assignment actions

### Admin → Customer Manage → Providers
- Path: `/admin/customer-manage/:customerId/providers` (`app/routes/admin+/customer-manage.$customerId.providers.tsx`)
- Actions
	- Create/Update provider NPI, Toggle Active
	- Update Group (assign/unassign)
	- Provider events logged (CREATED, UPDATED, ACTIVATED, GROUP_ASSIGNED, PCG_ADD_ATTEMPT/ERROR)
- Guardrails
	- Delete blocked if dependent assignments/submissions/letters exist
	- System Admin only

### Admin → Customer Manage → Provider Groups
- Path: `/admin/customer-manage/:customerId/provider-groups` (`app/routes/admin+/customer-manage.$customerId.provider-groups.tsx`)
- Actions: Create, Update (incl. active toggle), Delete (only when users/providers counts are zero)
- Guardrails: System Admin only; delete disabled with tooltip when blocked

### Admin → Customers and New Customer
- Paths: `/admin/customers`, `/admin/customers/new` (`app/routes/admin+/customers.tsx`, `app/routes/admin+/customers.new.tsx`)
- Customers list
	- Columns: Name, Description, BAA Number, Active, Created, Admins Count
	- Actions: Add Customer (drawer), Add Admin (per-row drawer)
- New Customer form: Name, Description, Active
- Guardrails: System Admin only; schema-validated inputs and toasts

### Admin → Organization Tools
- Audit Logs — `/admin/audit-logs` (`app/routes/admin+/audit-logs.tsx`)
	- Filters: search, action, entityType, category, status, chainKey, date range; cursor pagination; toggleable columns
	- Guardrails: System Admin only; export deferred (routes exist for future)
- Audit Maintenance — `/admin/audit-maintenance` (`app/routes/admin+/audit-maintenance.tsx`)
	- Actions: verify-chain, verify-all, archive (olderThanDays)
	- Guardrails: System Admin only
- Notifications Maintenance — `/admin/notifications` (`app/routes/admin+/notifications.tsx`)
	- Stats: total and purge-eligible by cutoff (default 7 days)
	- Action: purge (loader shows counts, action deletes, page revalidates)
	- Guardrails: System Admin only

### Admin → Providers eMDR Management
- Path: `/admin/providers-emdr-management` (`app/routes/admin+/providers-emdr-management.tsx`)
- Tables: Provider list with customer, group, assigned users/emails; registration status
- Actions: Fetch PCG providers, Update Provider Details, Fetch Registrations, Register/Deregister eMDR, Set Electronic Only, Reassign Provider Customer, Rename Customer
- Guardrails: System Admin only; confirm gates and audits for each action; chunked processing

### Customer → Submissions (index)
- Path: `/customer/submissions`
- Table: Submissions
	- Typical columns: Title, NPI, Purpose, Status, Created, Updated
	- Row actions: View/Continue, Retry (if ERROR), New Submission
	- Guardrails: Editing only allowed in Draft; non-draft rows link to read-only views

### Customer → Submissions → New (Step 1)
- Form: Metadata + Split + Document blocks
- Guardrails
	- RBAC scope on `providerId` (NPI)
	- Recipient must be valid for selected purpose (server-side revalidation)
	- PDF only; per-file and total MB limits
	- `docCount` required for manual split (1..99)
- Events/Audit: `DRAFT_CREATED`, `PCG_CREATE_*`, `PCG_STATUS`, `SUBMISSION_CREATED`

### Customer → Submissions → Review (Step 2)
- Controls: Metadata editor with purpose/recipient mapping and split settings
- Guardrails
	- Draft-only edit; redirect if not Draft
	- Toggle gate hides Update button until user confirms intent
	- Same validations as Step 1
- Events/Audit: `META_UPDATED`, `PCG_UPDATE_*`, `PCG_STATUS`, `SUBMISSION_UPDATED`

### Customer → Submissions → Upload (Step 3)
- Table: Document queue with progress/outcomes
- Guardrails: File type/size validations; required metadata; retries preserve state
- Events/Audit: upload results logged; statuses/transaction IDs updated via PCG status

### Providers & eMDR
- Path: `/providers-emdr`
- Table: Providers
	- Typical columns: NPI, Name, Group, Active, Assigned Users
	- Actions: Toggle Active, Assign/Unassign NPIs to users, Manage Group
	- Guardrails: Safe deactivation flows; constraints on unassign; full audit

### Admin → Users (representative)
- Table: Users
	- Typical columns: Name, Email, Roles, Status, 2FA
	- Actions: Activate/Deactivate, Reset Password/2FA, Assign NPIs
	- Guardrails: Block destructive deletes; suggest deactivate; respect RBAC on assignments; audit

### Admin → Provider Groups (representative)

### Customer → Users (User Management)
- Path: `/customer/users` (`app/routes/customer+/users.tsx`)
- Actions (intents)
	- Create/Update user (role: customer-admin or provider-group-admin depending on target)
	- Assign NPIs: intent `assign-npis`
	- Reset Password: intent `reset-password` with `mode` = auto|manual
	- Set Active: intent `set-active` (active|inactive)
	- Live Checks: intent `check-availability` for email/username
- Guardrails
	- Customer Admin can manage all users in customer; Provider Group Admin limited to non-customer-admin users in their group
	- Users cannot toggle themselves; Assign NPIs visibility limited to basic-user target
	- Zod-enforced username/email rules; shared manual password component

### Customer → Provider Groups
- Path: `/customer/provider-groups` (`app/routes/customer+/provider-groups.tsx`)
- Actions: Create/Update (active toggle), Delete (blocked with counts), search within customer
- Guardrails: Customer Admin only

### Customer/Group/Admin → Letters (Scoped)
- Path: `/customer/letters` (`app/routes/customer+/letters.tsx`)
- Purpose: View letters scoped by customer/group; first-view stamping handled at service layer
- Guardrails: Role-scoped access via loaders

### Basic User → My NPIs
- Path: `/my-npis` (`app/routes/my-npis.tsx`)
- Purpose: Quick, scoped list of user’s assigned NPIs with group info
- Guardrails: Basic User (and above) with customer association
- Table: Provider Groups
	- Typical columns: Name, Customer, Providers Count, Active
	- Actions: Edit, Activate/Deactivate, Manage Providers
	- Guardrails: Scoped by customer; deactivation safety

---

## 12) Security Appendix (2FA)

- TOTP-based 2FA; secrets stored server-side on the `User`
- Setup via `/me/2fa`; login flow prompts for code when enabled
- Admin 2FA reset clears secrets and disables 2FA, with audit trail

See: 2FA Implementation (full content included below in Appendix)

Summary
- Users can be required to enroll 2FA at next login; admins can enforce per-role or globally.
- Backup codes and WebAuthn (passkeys) are supported (if configured); fallback TOTP via `@epic-web/totp`.
- Password change route integrates 2FA checks.

---

## 13) Glossary

- PCG: Palmetto GBA (CMS HIH Wrapper)
- eMDR: Electronic Medical Documentation Request
- NPI: National Provider Identifier
- PHI: Protected Health Information
- RBAC: Role-Based Access Control
- ET: Eastern Time (America/New_York)
 - OID: Object Identifier (recipient directory IDs, often `urn:oid:<value>`)
 - ADR: Additional Documentation Request
 - X12: ANSI X12 EDI format for claims/attachments
 - ACN: Attachment Control Number (per-document identifier)

---

## 14) Roadmap and Deferred Items

- Re-enable Audit Logs export UI with background job option for large exports
- Background integrity sampler and metrics for audit chains
- Enhanced action vocabulary standardization across modules
- WebAuthn passkey support (scaffolded model present)

---

## 15) Quick Links

- Complete Guide (this document): `docs/INTEREX_FULL_GUIDE.md`
- PCG Services: `app/services/pcg-hih.server.ts`

---

## 16) RBAC Matrix (Summary)

| Capability | System Admin | Customer Admin | Provider Group Admin | Basic User |
|------------|--------------|----------------|----------------------|------------|
| View/Use Admin Users | Yes | No | No | No |
| Manage Customer’s Provider Groups | Yes (any) | Yes (own customer) | No | No |
| Manage Customer’s Providers/NPIs | Yes (any) | Yes (own customer) | Yes (own group scope) | No |
| Assign/Unassign NPIs | Yes | Yes | Yes (own group scope) | No |
| Toggle Provider Active | Yes | Yes | Yes (own group scope) | No |
| Submissions | Yes | Yes | Yes | Yes (for assigned NPIs) |
| Letters (All) | Yes | Possibly scoped by policy | Possibly scoped | No |

Notes
- “Own group scope” means only providers/users within the admin’s `providerGroupId` as enforced in loaders/actions.
- Guardrails prevent destructive actions when dependencies exist (e.g., delete blocks).

---

## 17) Troubleshooting

- PCG 401 errors: token refresh occurs once; verify `PCGF_*` env and network reachability.
- Audit verification mismatch: run `verifyChain({ chainKey })` to isolate; check recent events for manual edits (should not exist) or migration mismatches.
- Letters missing `downloadId`: opening a letter backfills from raw payload; re-open or resync.
- TypeScript or build issues: run `npm run typecheck`; check `tsconfig.json` paths and domain enum imports.
 - Recipient not available for a purpose: switch category or purpose; server will reject invalid OIDs for the chosen purpose.
 - Submissions stuck in non-Draft: Step 2 requires Draft; use the index page to retry or create a new submission.

---

## Appendix: Full Source Documents

The following sections include the complete content of the previously separate documentation files, verbatim, to keep this single guide fully self-contained.

### A. InterEx Technical Specification (full)

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
- Download: `pcgDownloadEmdrLetterFileContent`

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
- Letter sync audit metadata sanitized; raw payloads stored in DB but UI emphasizes non-PHI columns
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

### B. Audit Logging Architecture (full)

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

### C. Page Tables, Columns, Actions, Guardrails (full)

## Page tables, actions, and guardrails

This document catalogs the major pages that render data tables, the columns shown, available actions, and the guardrails/permissions that control behavior. It’s generated from a quick scan of the current codebase and should be kept in sync as features evolve.

Last updated: 2025-09-27 (branch: final-fix)

### Roles and common terms

- Roles seen in code: system-admin, customer-admin, provider-group-admin, basic-user
- Guardrails: role checks, 2FA, delete protections, group-alignment rules, audit logging, back-guard
- Conventions: most tables use global header styling and hover/focus states defined in `app/styles/tailwind.css`

---

## Admin • Customers

Route: `app/routes/admin+/customers.tsx`

- Table columns
	- Customer
	- BAA Number
	- Admins
	- Created
	- Status
	- Actions

- Actions
	- Add Customer (opens “Add New Customer” drawer)
	- Add Admin (per row, opens “Add Admin” drawer for that customer)

- Guardrails / permissions
	- Requires System Admin: `requireUserId`, `requireRoles(user, [SYSTEM_ADMIN])`
	- Back guard on the layout to discourage accidental back navigation: `backGuardEnabled`, `backGuardLogoutUrl`, `backGuardRedirectTo`, `backGuardMessage`

---

## Admin • Users (System)

Route: `app/routes/admin+/users.tsx` (cards/list, not a single table, but operationally similar)

- Visible fields per user card
	- Name, username, email, roles, customer, NPIs assigned count, 2FA status, joined date

- Actions
	- Send reset link (intent: `send-reset-link`)
	- Manual reset (temporary password) (intent: `manual-reset`)
	- Reset 2FA (intent: `reset-2fa`)

- Guardrails / permissions
	- Requires System Admin to view/use: `requireRoles(user, [SYSTEM_ADMIN])`
	- Confirm dialogs for destructive operations (manual reset, reset 2FA)
	- 2FA reset flow disables 2FA, clears secrets/verification, signs out sessions, and writes audit: `disableTwoFactorForUser`, delete `verification` of type '2fa', log `TWO_FACTOR_RESET`

---

## Admin • Customer Manage • Users

Route: `app/routes/admin+/customer-manage.$customerId.users.tsx`

- Table columns
	- Name
	- Email
	- Username
	- Roles
	- Status
	- Actions
	- Reset
	- Assign NPIs

- Actions and flows
	- Create user (drawer: intent `create`)
	- Edit user (drawer: intent `update`)
	- Reset password (auto/manual modes in drawer)
	- Assign NPIs (drawer with selection UI)
	- Deactivate and unassign NPIs (atomic): transaction removes `userNpi` rows, sets user `active=false`, deletes sessions, audit `USER_DEACTIVATE_AND_UNASSIGN`
	- Delete user (hard delete): guarded; on success, delete sessions then `user`

- Delete guardrails
	- Cannot delete System Admins
	- Cannot delete yourself
	- Cannot delete the last Customer Admin for the customer
	- FK-dependent records block delete: if submissions/documents/provider events exist, action returns `deleteBlocked` with counts and guidance, and audit `USER_DELETE_BLOCKED`

- Other guardrails / permissions
	- Page requires System Admin
	- Email/username availability checks with debounced server validation; username rules: length and allowed chars (see schema/constants in file)

---

## Customer • Users

Route: `app/routes/customer+/users.tsx`

- Table columns
	- Name
	- Username
	- Roles
	- Customer
	- Provider Group
	- NPIs (preview up to 3, with “+N more”)
	- Status (Active/Inactive)
	- Edit
	- Assign NPIs
	- Reset Password
	- Activate/Deactivate

- Actions
	- Edit user (drawer)
	- Assign NPIs (only shown for basic-user)
	- Reset password (if `canReset`)
	- Activate/Deactivate (if `canToggle`)

- Guardrails / permissions
	- Viewer-based controls:
		- Customer Admins can reset/toggle any user
		- Provider Group Admins can reset/toggle only non-customer-admin users within their provider group
	- Users cannot toggle themselves
	- Assign NPIs visibility limited to `basic-user`

---

## Customer • Provider NPIs

Route: `app/routes/customer+/provider-npis.tsx`

- Table columns
	- NPI
	- Provider Name
	- Provider Group
	- User (assigned)
	- Assign User (popover: add/remove with checklists)
	- Status (Active/Inactive)
	- Edit
	- Provider Group (assign/change popover)
	- Activate / Deactivate NPI

- Actions
	- Manage user assignments (intent: `bulk-update-user-assignments`)
	- Edit provider (drawer)
	- Assign/Change provider group (intent: `update-group`)
	- Toggle active (intent: `toggle-active`)

- Guardrails / permissions
	- Group alignment rule for user assignment:
		- If provider has a group → only users in that group are eligible
		- If provider ungrouped → only users with no group are eligible
	- `hasEligibleNewUser` gating: disables “Assign” when no eligible users
	- Group change may be blocked via `eligibility.groupChangeBlocked` with tooltip reason
	- Toggle active requires permissions and respects `canToggle`; disabled state shows tooltip

---

## Admin • Customer Manage • Provider Groups

Route: `app/routes/admin+/customer-manage.$customerId.provider-groups.tsx`

- Table columns
	- Name
	- Description
	- Users
	- NPIs
	- Edit
	- Delete

- Actions
	- Create group (drawer, intent: `create`)
	- Edit group (drawer, intent: `update` + active toggle)
	- Delete group (only when counts are zero; else icon shown disabled with tooltip)

- Guardrails / permissions
	- Requires System Admin
	- Delete blocked when group has assigned users or providers

---

## Admin • Audit Logs

Route: `app/routes/admin+/audit-logs.tsx`

- Table columns (toggleable via `visibleCols`)
	- Time (EST)
	- Customer
	- Actor
	- Category
	- Action
	- Entity
	- Status
	- Summary / Message
	- Chain
	- Raw

- Actions
	- Export (see `admin+/audit-logs.export.ts` and `admin+/audit-logs+/export.ts`)

- Guardrails / permissions
	- Admin-only access enforced in export routes and likely page loader

---

## Admin • Reports

Route: `app/routes/admin+/reports.tsx`

- Table columns
	- Dynamic via config (`c.l`) rendered as `<th>`; labels include report-specific fields

- Guardrails / permissions
	- Admin-only context assumed (check route for `requireRoles` in loader/action)

---

## Admin • All Letters

Route: `app/routes/admin+/all-letters.tsx`

- Table columns (wide table)
	- Fetched (ET)
	- Letter ID
	- Letter Name
	- NPI
	- Provider
	- Customer
	- Provider Group
	- Assigned To
	- PDF
	- First Viewed (ET)
	- Letter Date
	- Respond By
	- Days Left (ET)
	- Jurisdiction
	- Program
	- Stage

- Guardrails / permissions
	- Admin context; review loader/action for exact role requirement

---

## My NPIs

Route: `app/routes/my-npis.tsx`

- Table columns
	- NPI
	- Provider Name
	- Provider Group
	- Status
	- Quick Links

- Guardrails / permissions
	- User-scoped view of their assigned NPIs

---

## Customer • Submissions

Route: `app/routes/customer+/submissions.tsx`

- Tables
	- Submissions listing (fixed layout table with status, time, title, esMD Txn ID, split)
	- Activity/details tables in drawers/sections

- Guardrails / permissions
	- Customer-scoped; actions restricted to authorized users

---

## Global security guardrails

- 2FA on login
	- Logic in `app/routes/_auth+/login.server.ts`
	- If `REQUIRE_2FA_ON_LOGIN` policy requires and user does not have 2FA enabled or not recently verified, redirect to `/2fa-setup` (enroll) or `/2fa` (verify) before granting a full session
	- Post-2FA, password-change enforcement is applied when required

- Role-based access
	- `requireUserId` for authentication and `requireRoles` / `requireUserWithRole` for authorization used across admin routes

- Delete/Deactivate safety
	- User delete safeguards (self-delete prevention, last-admin protection, FK-dependent blocks)
	- Deactivate-and-unassign is atomic and audited

- Audit logging
	- Major admin actions write audit entries with `kind`, `message`, `metadata`

---

## UI consistency notes

- Global table styling
	- Dark blue headers with white text, borders, subtle rounded corners, shadow “lift”, and darker row hover for focus
	- Implemented in `app/styles/tailwind.css` via Tailwind component layer utilities

---

## Maintenance checklist for this doc

When changing a page with a table:

- Update the table column list here
- Add/remove actions and note the `intent` names when forms are involved
- Document any new guardrails or permission checks

If a new page adds tables, add a new section under the appropriate area (Admin/Customer/My). 

---

## Customer • Providers & eMDR (Scoped)

Route: `app/routes/providers-emdr.tsx`

- Scope and who sees what
	- System Admin: all providers
	- Customer Admin: providers within their customer
	- Provider Group Admin: providers within any group they belong to (direct `providerGroupId` or via `providerGroupMember`)
	- Basic User: providers assigned to them (`userNpis` relation) within their customer

- Tables and columns
	- Provider Details Updating
		- Provider NPI
		- Last Submitted Transaction
		- Registered for eMDR
		- Electronic Only?
		- Customer Name
		- Provider Group
		- Assigned To
		- Email IDs
		- Provider Name
		- Street
		- Street 2
		- City
		- ZIP
		- State
		- Registration Status
		- Provider ID
		- JSON
		- Update Provider
		- Update Response

	- eMDR Register/deRegister: Not registered for eMDR
		- Columns: NPI, Name, Reg Status, Stage, Errors, Provider ID, Actions

	- eMDR Register/deRegister: Registered for eMDR
		- Columns: NPI, Name, Electronic Only?, Reg Status, Stage, TXN IDs, Errors, Provider ID, Actions

	- eMDR Register/deRegister: Registered for Electronic-Only ADR
		- Columns: NPI, Name, Reg Status, Stage, Errors, Provider ID, Actions

- Actions
	- Fetch from PCG (intent: `fetch`) — imports providers from PCG, upserts local Provider records and snapshots
	- Update Provider Details (intent: `update-provider`) — drawer with required fields; writes `pcgUpdateResponse`, updates Provider, refreshes PCG list snapshot
	- Fetch Registration Details (intent: `fetch-registrations`) — calls PCG for eligible providers, upserts `ProviderRegistrationStatus`
	- Register for eMDR (intent: `emdr-register`) — requires Provider ID
	- Deregister from eMDR (intent: `emdr-deregister`)
	- Set Electronic Only (intent: `emdr-electronic-only`) — only shown if not already electronic-only
	- Error details popover — view JSON of errors/status for a row

- Guardrails and prerequisites
	- Auth required: `requireUserId`
	- Role-scoped visibility: `buildScopeWhere` limits which providers are visible; actions are inherently scoped to visible rows
	- eMDR action prerequisites: provider name and full address must be present; a `provider_id` is required (otherwise buttons disabled with helper text)
	- Confirm checkbox required before submitting any eMDR action
	- Chunking: bulk updates and fetches are processed in small batches to avoid timeouts
	- Audit logging: writes entries for `PCG_FETCH`, `PROVIDER_UPDATE`, `REG_FETCH`, `EMDR_REGISTER`, `EMDR_DEREGISTER`, `EMDR_ELECTRONIC_ONLY` with actor, roles, route, and metadata
	- Pending-state UX: loading overlay; action buttons disabled while pending
	- Error handling: top-level `pcgError` banner; sticky JSON popover with detailed error payloads; registration fetch stores a fallback payload on failures
	- Data freshness: after updates, the PCG list snapshot and registration status are refreshed when possible
	- Action visibility: “Set Electronic Only” button is hidden when already in that state

- Notes
	- JSON cells use `JsonViewer` for large payloads
	- Helpers normalize arrays to CSV strings for display (e.g., transaction IDs)

### D. 2FA Implementation Summary (full)

# 2FA Implementation Summary

## What was implemented

Two-Factor Authentication (2FA) to the InterEx login system with the following features:

### Database Changes
- Added `twoFactorSecret` and `twoFactorEnabled` fields to the User model
- Applied database migration to add these fields

### Backend Implementation
- 2FA utility functions (`app/utils/twofa.server.ts`)
	- Generate TOTP secrets and QR codes using @epic-web/totp
	- Verify TOTP tokens with time window tolerance
	- Enable/disable 2FA for users
	- Get user 2FA status

### Frontend Implementation
- 2FA Setup Page (`/me/2fa`)
	- QR code generation for authenticator apps
	- Manual secret entry as backup
	- Code verification to enable 2FA
	- Disable 2FA functionality

- 2FA Login Flow (`/auth/2fa`)
	- Intercepts login when user has 2FA enabled
	- Prompts for 6-digit authenticator code
	- Maintains login context (remember me, redirect URL)

- Updated Login Process (`/auth/login`)
	- Checks if user has 2FA enabled after password verification
	- Redirects to 2FA verification instead of completing login
	- Maintains all login parameters through the flow

- User Interface Updates
	- Added 2FA link to user dropdown menu
	- Modern, responsive UI design
	- Clear error messages and validation

## How to use

### For Users:
1. Enable 2FA: Click on user dropdown → "Two-Factor Auth" → "Set up 2FA"
2. Scan QR code with authenticator app (Google Authenticator, Authy, 1Password, etc.)
3. Enter verification code from app to enable 2FA
4. Login with 2FA: Enter username/password → Enter 6-digit code from authenticator app

### For Testing:
1. Create a user account and set up 2FA
2. Log out and try logging back in
3. You'll be prompted for the 2FA code after entering correct credentials

### Authenticator App Compatibility:
- Google Authenticator
- Authy  
- 1Password
- Microsoft Authenticator
- Any TOTP-compatible app

## Security Features
- Uses industry-standard TOTP (Time-based One-Time Password) 
- 30-second time windows with 1-window tolerance for clock drift
- Secure secret generation using cryptographically secure random
- QR codes generated server-side for security
- 2FA bypass prevention - cannot complete login without valid code

## Next Steps
You can test the 2FA functionality by:
1. Running your app locally with `npm run dev`
2. Creating a user account
3. Setting up 2FA from the user dropdown
4. Testing the login flow

The implementation is production-ready and follows security best practices!

### E. Documentation Migration Notes (full)

# Documentation Migration Notes

Date: 2025-09-27

We consolidated project documentation into the `docs/` folder and created a single comprehensive guide.

Moved and consolidated:
- 2FA-IMPLEMENTATION.md → docs/2FA-IMPLEMENTATION.md
- AUDIT_LOGGING.md → docs/AUDIT_LOGGING.md
- TECHNICAL_SPEC.md → docs/TECHNICAL_SPEC.md
- New: docs/INTEREX_FULL_GUIDE.md (single-file, end-to-end overview)

What to update going forward:
- Add new docs under `docs/`
- Keep `docs/INTEREX_FULL_GUIDE.md` updated for any major feature changes
- Link feature-specific docs from the full guide and README

