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
