import { redirect } from 'react-router'
import { INTEREX_ROLES } from './interex-roles.ts'

export type UserRole = {
  name: string
}

export type User = {
  id: string
  roles: UserRole[]
}

/**
 * Get the primary role for a user (highest authority role)
 */
export function getPrimaryRole(user: User): string {
  const roleNames = user.roles.map(r => r.name)
  
  // Check roles in order of authority (highest to lowest)
  if (roleNames.includes(INTEREX_ROLES.SYSTEM_ADMIN)) return INTEREX_ROLES.SYSTEM_ADMIN
  if (roleNames.includes(INTEREX_ROLES.CUSTOMER_ADMIN)) return INTEREX_ROLES.CUSTOMER_ADMIN
  if (roleNames.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)) return INTEREX_ROLES.PROVIDER_GROUP_ADMIN
  if (roleNames.includes(INTEREX_ROLES.BASIC_USER)) return INTEREX_ROLES.BASIC_USER
  
  return INTEREX_ROLES.BASIC_USER // fallback
}

/**
 * Get the dashboard URL for a user based on their primary role
 */
export function getDashboardUrl(user: User): string {
  const primaryRole = getPrimaryRole(user)
  
  switch (primaryRole) {
    case INTEREX_ROLES.SYSTEM_ADMIN:
      return '/admin/dashboard'
    case INTEREX_ROLES.CUSTOMER_ADMIN:
      return '/customer'
    case INTEREX_ROLES.PROVIDER_GROUP_ADMIN:
      return '/provider'
    case INTEREX_ROLES.BASIC_USER:
      return '/customer/submissions'
    default:
      return '/' // fallback to home page for unknown roles
  }
}

/**
 * Redirect user to their appropriate dashboard based on role
 */
export function redirectToDashboard(user: User) {
  const dashboardUrl = getDashboardUrl(user)
  throw redirect(dashboardUrl)
}

/**
 * Check if user has required role access for a route
 */
export function hasRoleAccess(user: User, requiredRoles: string[]): boolean {
  const userRoles = user.roles.map(r => r.name)
  return requiredRoles.some(role => userRoles.includes(role))
}

/**
 * Require specific roles for route access
 */
export function requireRoles(user: User | null, requiredRoles: string[], redirectTo: string = '/') {
  if (!user) {
    throw redirect('/login')
  }
  
  if (!hasRoleAccess(user, requiredRoles)) {
    throw redirect(redirectTo)
  }
  
  return user
}

/**
 * Check if user has system admin role
 */
export function isSystemAdmin(user: User): boolean {
  const roleNames = user.roles.map(r => r.name)
  return roleNames.includes(INTEREX_ROLES.SYSTEM_ADMIN)
}

/**
 * Check if user has customer admin role or higher (including system admin)
 */
export function hasCustomerAdminAccess(user: User): boolean {
  const roleNames = user.roles.map(r => r.name)
  return roleNames.includes(INTEREX_ROLES.SYSTEM_ADMIN) || roleNames.includes(INTEREX_ROLES.CUSTOMER_ADMIN)
}

/**
 * Check if user has provider group admin role or higher (including system admin and customer admin)
 */
export function hasProviderGroupAdminAccess(user: User): boolean {
  const roleNames = user.roles.map(r => r.name)
  return roleNames.includes(INTEREX_ROLES.SYSTEM_ADMIN) || 
         roleNames.includes(INTEREX_ROLES.CUSTOMER_ADMIN) || 
         roleNames.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)
}
