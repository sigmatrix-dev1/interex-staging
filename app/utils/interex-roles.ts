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
    case INTEREX_ROLES.SYSTEM_ADMIN:
      return {
        canCreate: allSubmissionTypes,
        canView: allSubmissionTypes,
        canManageUsers: true,
        canManageNPIs: true,
        canManageProviderGroups: true,
        canManageCustomers: true,
        scope: 'system' // Can manage everything across all customers
      }

    case INTEREX_ROLES.CUSTOMER_ADMIN:
      return {
        canCreate: allSubmissionTypes,
        canView: allSubmissionTypes,
        canManageUsers: true,
        canManageNPIs: true,
        canManageProviderGroups: true,
        scope: 'customer' // Can manage across all provider groups in customer
      }
    
    case INTEREX_ROLES.PROVIDER_GROUP_ADMIN:
      return {
        canCreate: allSubmissionTypes,
        canView: allSubmissionTypes,
        canManageUsers: true,
        canManageNPIs: true,
        canManageProviderGroups: false,
        scope: 'provider-group' // Can only manage within assigned provider group
      }
    
    case INTEREX_ROLES.BASIC_USER:
      return {
        canCreate: allSubmissionTypes,
        canView: allSubmissionTypes,
        canManageUsers: false,
        canManageNPIs: false,
        canManageProviderGroups: false,
        scope: 'user' // No management capabilities
      }
    
    default:
      return {
        canCreate: [],
        canView: [],
        canManageUsers: false,
        canManageNPIs: false,
        canManageProviderGroups: false,
        scope: 'none'
      }
  }
}

/**
 * Check if user can manage resources within a specific provider group
 */
export function canManageProviderGroup(userRoles: string[], userProviderGroupId: string | null, targetProviderGroupId: string): boolean {
  const roleNames = userRoles.map(role => typeof role === 'string' ? role : role)
  
  // System admins can manage all provider groups
  if (roleNames.includes(INTEREX_ROLES.SYSTEM_ADMIN)) {
    return true
  }
  
  // Customer admins can manage all provider groups within their customer
  if (roleNames.includes(INTEREX_ROLES.CUSTOMER_ADMIN)) {
    return true
  }
  
  // Provider group admins can only manage their assigned provider group
  if (roleNames.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)) {
    return userProviderGroupId === targetProviderGroupId
  }
  
  return false
}

/**
 * Get the scope filter for database queries based on user role and provider group
 */
export function getScopeFilter(userRoles: string[], userProviderGroupId: string | null, customerId: string) {
  const roleNames = userRoles.map(role => typeof role === 'string' ? role : role)
  
  // System admins see everything
  if (roleNames.includes(INTEREX_ROLES.SYSTEM_ADMIN)) {
    return {
      // No filtering needed for system admins
    }
  }
  
  // Customer admins see everything in their customer
  if (roleNames.includes(INTEREX_ROLES.CUSTOMER_ADMIN)) {
    return {
      customerId,
      // No additional filtering needed
    }
  }
  
  // Provider group admins only see their provider group
  if (roleNames.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN) && userProviderGroupId) {
    return {
      customerId,
      providerGroupId: userProviderGroupId,
      // Additional filter for provider group
    }
  }
  
  // Basic users shouldn't have access to management features
  return null
}
