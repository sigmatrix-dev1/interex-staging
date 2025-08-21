/**
 * Interex Role Hierarchy and Permission Utilities
 * 
 * This module handles the CMS Interex role hierarchy logic using role names
 * instead of separate level columns.
 */

// Interex Role Names (hierarchical order)
export const INTEREX_ROLES = {
  SYSTEM_ADMIN: 'system-admin',
  CUSTOMER_ADMIN: 'customer-admin',
  PROVIDER_GROUP_ADMIN: 'provider-group-admin', 
  BASIC_USER: 'basic-user',
} as const

export const ALL_ROLES = { ...INTEREX_ROLES } as const

type RoleName = typeof ALL_ROLES[keyof typeof ALL_ROLES]

/**
 * Get the hierarchy level of a role (lower number = higher authority)
 */
export function getRoleLevel(roleName: string): number {
  switch (roleName) {
    case INTEREX_ROLES.SYSTEM_ADMIN:
      return 0
    case INTEREX_ROLES.CUSTOMER_ADMIN:
      return 1
    case INTEREX_ROLES.PROVIDER_GROUP_ADMIN:
      return 2
    case INTEREX_ROLES.BASIC_USER:
      return 3
    default:
      return 999 // Unknown roles get lowest priority
  }
}

/**
 * Check if a user role has higher or equal authority than required role
 */
export function hasRoleAuthority(userRole: string, requiredRole: string): boolean {
  return getRoleLevel(userRole) <= getRoleLevel(requiredRole)
}

/**
 * Check if a user has any Interex-specific role
 */
export function isInterexUser(userRoles: string[]): boolean {
  return userRoles.some(role => Object.values(INTEREX_ROLES).includes(role as any))
}

/**
 * Get the highest authority role from a list of roles
 */
export function getHighestAuthorityRole(roles: string[]): string | null {
  if (roles.length === 0) return null
  
  return roles.reduce((highest, current) => {
    return getRoleLevel(current) < getRoleLevel(highest) ? current : highest
  })
}

/**
 * Check if user can manage another user based on role hierarchy
 */
export function canManageUser(managerRoles: string[], targetUserRoles: string[]): boolean {
  const managerHighestRole = getHighestAuthorityRole(managerRoles)
  const targetHighestRole = getHighestAuthorityRole(targetUserRoles)
  
  if (!managerHighestRole || !targetHighestRole) return false
  
  return getRoleLevel(managerHighestRole) < getRoleLevel(targetHighestRole)
}

/**
 * Get permissions for Interex submission types based on role
 */
export function getSubmissionPermissions(roleName: string) {
  const allSubmissionTypes = [
    'ADR', 'PA_ABT', 'PA_DMEPOS', 'HH_PRE_CLAIM', 'HOPD', 
    'PWK', 'FIRST_APPEAL', 'SECOND_APPEAL', 'DME_DISCUSSION',
    'RA_DISCUSSION', 'ADMC', 'IRF'
  ]

  switch (roleName) {
    case INTEREX_ROLES.CUSTOMER_ADMIN:
    case INTEREX_ROLES.PROVIDER_GROUP_ADMIN:
      return {
        canCreate: allSubmissionTypes,
        canView: allSubmissionTypes,
        canManageUsers: true,
        canManageNPIs: roleName === INTEREX_ROLES.CUSTOMER_ADMIN,
        canManageProviderGroups: roleName === INTEREX_ROLES.CUSTOMER_ADMIN
      }
    
    case INTEREX_ROLES.BASIC_USER:
      return {
        canCreate: allSubmissionTypes,
        canView: allSubmissionTypes,
        canManageUsers: false,
        canManageNPIs: false,
        canManageProviderGroups: false
      }
    
    default:
      return {
        canCreate: [],
        canView: [],
        canManageUsers: false,
        canManageNPIs: false,
        canManageProviderGroups: false
      }
  }
}
