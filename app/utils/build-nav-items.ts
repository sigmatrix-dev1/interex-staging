import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { type User } from '#app/utils/role-redirect.server.ts'

export type NavLink = { type: 'link'; name: string; href: string; icon: string; description: string }
export type NavGroup = { type: 'group'; name: string; icon: string; items: NavLink[]; description?: string }
export type NavItem = NavLink | NavGroup

const makeLink = (name: string, href: string, icon: string, description: string): NavLink => ({ type: 'link', name, href, icon, description })

export function buildNavItems(user: User): NavItem[] {
	const roles = user.roles.map(r => r.name)
	const isSystem = roles.includes(INTEREX_ROLES.SYSTEM_ADMIN)
	const isCustomerAdmin = roles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
	const isProviderGroupAdmin = roles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)
	const isBasic = roles.includes(INTEREX_ROLES.BASIC_USER)

	const items: NavItem[] = []

	// Dashboard
	if (isSystem) items.push(makeLink('Dashboard', '/admin/dashboard', 'hero:dashboard', 'System administration overview'))
	else if (isCustomerAdmin) items.push(makeLink('Dashboard', '/customer', 'hero:dashboard', 'Customer overview'))
	else if (isProviderGroupAdmin) items.push(makeLink('Dashboard', '/provider', 'hero:dashboard', 'Provider group overview'))

	// Organization
	if (isSystem) {
		items.push({ type: 'group', name: 'Organization', icon: 'hero:users', items: [
			makeLink('Audit Logs', '/admin/audit-logs', 'hero:logs', 'System audit trail'),
			makeLink('Audit Maintenance', '/admin/audit-maintenance', 'hero:refresh', 'Verify chains & archive batches'),
			makeLink('Notifications', '/admin/notifications', 'hero:bell', 'Purge & manage notifications'),
		] })
	} else if (isCustomerAdmin) {
		items.push({ type: 'group', name: 'Organization', icon: 'hero:users', items: [
			makeLink('Provider Groups', '/customer/provider-groups', 'hero:users', 'Manage provider groups'),
			makeLink('User Management', '/customer/users', 'hero:users', 'Manage organization users'),
		] })
	} else if (isProviderGroupAdmin) {
		items.push({ type: 'group', name: 'Organization', icon: 'hero:users', items: [
			makeLink('Group Users', '/customer/users', 'hero:users', 'Manage group users'),
		] })
	}

	// Provider (singular label per UX request)
	if (isSystem) {
		items.push({ type: 'group', name: 'Provider', icon: 'id-card', items: [
			makeLink('Provider & eMDR Mgmt', '/admin/providers-emdr-management', 'id-card', 'Manage providers (all customers)'),
		] })
	} else if (isCustomerAdmin || isProviderGroupAdmin || isBasic) {
		items.push({ type: 'group', name: 'Provider', icon: 'id-card', items: [
			...(isBasic ? [makeLink('My NPIs', '/my-npis', 'lock-closed', 'View assigned NPIs')] : []),
			makeLink('Provider NPIs', '/customer/provider-npis', 'id-card', 'Manage provider NPIs'),
			makeLink('Provider & eMDR Mgmt', '/providers-emdr', 'envelope-closed', 'eMDR Registration / Management'),
		] })
	}

	// Submissions
	if (isCustomerAdmin || isProviderGroupAdmin || isBasic) {
		items.push(makeLink('Submissions', '/customer/submissions', 'hero:submissions', 'Manage HIH submissions'))
	}

	// Letters
	if (isSystem) items.push(makeLink('Letters', '/admin/all-letters', 'hero:letters', 'All letters for your NPIs'))
	else if (isCustomerAdmin || isProviderGroupAdmin || isBasic) items.push(makeLink('Letters', '/customer/letters', 'hero:letters', 'All letters for your NPIs'))

	return items
}
