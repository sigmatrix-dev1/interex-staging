# InterEx User Guide

## Getting Started

### Sign In and Security
- You sign in with your email/username and password.
- Two-Factor Authentication (2FA) is required. If prompted, follow the on-screen steps to set it up.
- If you forget your password, an admin can send you a reset link or provide a temporary password.

### The Dashboard
- The dashboard is your home page. It highlights common actions and shortcuts.
- What you see depends on your role (System Admin, Customer Admin, Provider Group Admin, or Basic User).

---

## Core Concepts (simple definitions)
- Customer: Your organization/tenant in the system.
- Provider Group: A way to organize providers (for example, by location or team). Users can be scoped to a group.
- Provider (NPI): A healthcare provider record identified by a 10-digit NPI number.
- Submissions: Items you send for processing and track through stages.
- Letters: Correspondence related to providers or submissions (for example, pre-pay or post-pay letters).
- Notifications: System messages for users.

---

## What each role can do

### System Admin (full platform control)
You can manage all customers, users, providers, groups, letters, and reports.
- Reports: Run and export consolidated reports across the platform.
- Users (Admin): Create and manage users across customers; reset passwords; reset 2FA; activate/deactivate users.
- Manage Customer: Dive into any specific customer to manage their users, providers (NPIs), and provider groups.
- Customers: Add new customers and see all customers with key info.
- Organization Tools: Review audit logs, verify audit history, and maintain notifications.
- Providers eMDR Management: Oversee electronic delivery registration (eMDR) at scale.
- All Letters: Browse all letters, with filters for type and date.

### Customer Admin (manage your own customer)
You manage users, provider groups, providers (NPIs), submissions, and letters for your customer.
- Provider Groups and Users: Create, edit, and organize your teams and members.
- Provider NPIs: Add providers, assign to groups, switch active/inactive, and maintain rosters.
- Providers & eMDR (scoped): View and (depending on policy) request or adjust eMDR status for your providers.
- Submissions and Letters: Create, track, and review your customer’s submissions and letters.

### Provider Group Admin (manage within your group)
You manage users within your group, providers assigned to your group, and related submissions and letters.
- Users (Group-Scoped): Manage non-customer-admin users in your group.
- Provider NPIs: Maintain providers for your group.
- Providers & eMDR (scoped): View registration status; request updates if allowed by policy.
- Submissions and Letters: Work with items related to your group.

### Basic User (day-to-day work)
You focus on your own assigned providers and related tasks.
- My NPIs: See the providers assigned directly to you.
- Provider NPIs (scoped): View providers you’re allowed to see.
- Providers & eMDR (scoped): View registration status.
- Submissions and Letters: Create and track items relevant to you.
- Note: A dedicated Basic User dashboard is coming soon.

---

## Pages and Features (plain-language)

Below are the main pages you may see and what you can do on them. Your role determines which pages appear.

### Reports (System Admin)
- Purpose: A central place to run reports about submissions, letters, providers, and more.
- What you can do:
  - Choose a customer (or all customers) and date ranges
  - Filter by section (for example, submissions or letters)
  - Export results for analysis
- When to use: For oversight, compliance, and executive reporting.

### Users (System Admin)
- Purpose: Manage all users across the platform.
- What you can do:
  - Create users and select their role
  - Assign a customer and optionally a provider group
  - Activate or deactivate a user
  - Reset a user’s password via email link or manual temporary password
  - Reset 2FA if a user loses access to their authenticator app
- Safety features:
  - The system prevents risky actions (for example, removing the last required admin)
  - All sensitive changes are recorded for accountability

### Manage Customer (System Admin)
A focused workspace for a single customer with three main areas:

1) Overview
- View key details about the customer, including activity and counts

2) Users
- Create and edit users for that customer
- Assign or remove provider access (NPIs)
- Deactivate and unassign in one step when someone leaves the team
- Reset passwords
- Safety features: Deletions are blocked if it would remove the only admin or if the user has important history

3) Providers (NPIs)
- Add providers by NPI and set their display names
- Assign or change provider groups
- Mark providers active or inactive
- When appropriate, log key changes for traceability

4) Provider Groups
- Create, rename, describe, and activate/deactivate groups
- Delete groups only when they’re empty (no users or providers)
- Search and filter to find groups quickly

### Customers (System Admin)
- Purpose: See all customers and add new ones.
- What you can do:
  - View name, description, and basic stats
  - Add a new customer with a name and settings
  - Quickly see how many admins a customer has

### Audit Logs (System Admin)
- Purpose: A searchable history of important actions in the system.
- Features:
  - Search by keywords
  - Filter by action, status, date, and other fields
  - Show or hide advanced columns to focus on what matters
- Use it to answer “who changed what and when.”

### Audit Maintenance (System Admin)
- Purpose: Keep the audit history healthy and tidy.
- Features:
  - Check that audit entries form a complete, consistent chain
  - Archive older entries based on a time window
- Good for routine compliance and performance housekeeping.

### Notifications Maintenance (System Admin)
- Purpose: Manage system notifications across users.
- Features:
  - See how many total notifications exist
  - See how many are old enough to be cleaned up
  - Purge older notifications safely

### Providers eMDR Management (System Admin)
- Purpose: Oversee electronic delivery registration (eMDR) for providers at scale.
- What you can do:
  - Look up providers and their registration status
  - Register or deregister when needed
  - Mark accounts electronic-only where supported
  - Reassign a provider’s customer or adjust naming for clarity
- Ideal for central ops teams that coordinate many NPIs.

### Provider Groups (Customer Admin)
- Purpose: Organize your providers and users into logical groups.
- Features:
  - Create, rename, describe, activate/deactivate groups
  - Delete groups when empty
  - Search to find the right group quickly

### Users (Customer Admin and Provider Group Admin)
- Purpose: Manage users within your scope.
- What you can do:
  - Create and edit users
  - Assign users to provider groups (Customer Admin)
  - Assign provider access (NPIs) to users (for day-to-day work)
  - Activate or deactivate users
  - Reset passwords via link or manual temporary password
- Safety features:
  - Group admins can only manage users in their own group and cannot modify customer admins
  - The system prevents removing critical access by mistake

### Provider NPIs (Customer Admin and Provider Group Admin)
- Purpose: Maintain your roster of providers.
- What you can do:
  - Add providers using their NPI
  - Name or rename providers for easy identification
  - Assign providers to a group
  - Mark providers as active or inactive
  - Depending on setup, request registration updates with partner systems

### Providers & eMDR (Scoped)
- Purpose: See registration status for providers and, if permitted, request or update electronic delivery settings.
- Who sees this: Customer Admin, Provider Group Admin, Basic User (view scope varies by role).
- Typical actions:
  - Check registration status
  - For admins, request changes where allowed by policy

### Submissions (Customer Admin, Provider Group Admin, Basic User)
- Purpose: Create, track, and manage submissions.
- What you can do:
  - Start a new submission and add details
  - Upload documents as needed
  - Track progress as your submission moves through stages (for example, Draft → Submitted)
  - Search and sort to find what you need quickly
- Helpful for ensuring complete, timely submissions and visibility for your team.

### Letters (Customer Admin, Provider Group Admin, Basic User)
- Purpose: View and track letters related to your providers and activities.
- What you can do:
  - Filter by type and date
  - See who a letter is for and related details
  - Download or open to review

### All Letters (System Admin)
- Purpose: A consolidated view of all letters across all customers.
- Features:
  - Tabs by letter type (for example, pre-pay and post-pay)
  - Filters to narrow to specific customers, groups, or providers
  - Sort by date and other fields

### My NPIs (Basic User)
- Purpose: A personal list of providers assigned to you.
- Use this as your shortcut to daily work.

---

## Safety, Privacy, and Accountability
We designed InterEx to help you do the right thing safely:
- Role-Based Access: People only see and act on what their role allows.
- Protective Rules: The system blocks risky actions (for example, removing the last admin for a customer) and prevents deletions when important links exist.
- Audit Trail: Sensitive changes are recorded so teams can review who changed what and when.
- Password & 2FA Resets: Admins can help users regain access securely.

---

## Tips and Best Practices
- Keep groups tidy: archive or delete groups you no longer use (after moving people and providers).
- Use “Deactivate” instead of “Delete” when you might need to restore access later.
- Add clear names and descriptions to groups and providers so your team can search and filter quickly.
- For sensitive actions, take an extra moment to review prompts and confirmations.

---

## Glossary
- Active/Inactive: Whether a user or provider can be used right now.
- Assign: Give a user access to specific providers (NPIs) or to a provider group.
- eMDR: Electronic delivery of certain notifications or documents from payers or partners.
- NPI: National Provider Identifier, a 10-digit ID for healthcare providers in the US.
- Submission: A packet of information you send and track to completion.

---

If you need help or training, contact your InterEx administrator.
