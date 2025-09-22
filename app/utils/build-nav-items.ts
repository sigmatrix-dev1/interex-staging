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
	if (isSystem) items.push(makeLink('Dashboard', '/admin/dashboard', 'gear', 'System administration overview'))
	else if (isCustomerAdmin) items.push(makeLink('Dashboard', '/customer', 'gear', 'Customer overview'))
	else if (isProviderGroupAdmin) items.push(makeLink('Dashboard', '/provider', 'gear', 'Provider group overview'))

	// Organization
	if (isSystem) {
		items.push({ type: 'group', name: 'Organization', icon: 'avatar', items: [
			makeLink('Audit Logs', '/admin/audit-logs', 'file-text', 'System audit trail'),
			makeLink('Audit Maintenance', '/admin/audit-maintenance', 'gear', 'Verify chains & archive batches'),
		] })
	} else if (isCustomerAdmin) {
		items.push({ type: 'group', name: 'Organization', icon: 'avatar', items: [
			makeLink('Provider Groups', '/customer/provider-groups', 'gear', 'Manage provider groups'),
			makeLink('User Management', '/customer/users', 'avatar', 'Manage organization users'),
		] })
	} else if (isProviderGroupAdmin) {
		items.push({ type: 'group', name: 'Organization', icon: 'avatar', items: [
			makeLink('Group Users', '/customer/users', 'avatar', 'Manage group users'),
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
		items.push(makeLink('Submissions', '/customer/submissions', 'envelope-closed', 'Manage HIH submissions'))
	}

	// Letters
	if (isSystem) items.push(makeLink('Letters', '/admin/all-letters', 'file-text', 'All letters for your NPIs'))
	else if (isCustomerAdmin || isProviderGroupAdmin || isBasic) items.push(makeLink('Letters', '/customer/letters', 'file-text', 'All letters for your NPIs'))

	return items
}
