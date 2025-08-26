import { Link } from 'react-router'
import { Icon } from '#app/components/ui/icon.tsx'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { type User } from '#app/utils/role-redirect.server.ts'

interface InterexNavigationProps {
    user: User
    currentPath?: string
}

export function InterexNavigation({ user, currentPath }: InterexNavigationProps) {
    const userRoles = user.roles.map(r => r.name)
    const navItems: Array<{ name: string; href: string; icon: string; description: string }> = []

    // System Admin (MOVED page here)
    if (userRoles.includes(INTEREX_ROLES.SYSTEM_ADMIN)) {
        navItems.push(
            {
                name: 'Admin Dashboard',
                href: '/admin/dashboard',
                icon: 'settings',
                description: 'System administration',
            },
            {
                name: 'Provider & eMDR Management',
                href: '/admin/providers-emdr-management',
                icon: 'id-card',
                description: 'Manage providers (all customers)',
            },
        )
    }

    // Customer Admin (REMOVED Provider & eMDR Management from here)
    if (userRoles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)) {
        navItems.push(
            {
                name: 'Customer Dashboard',
                href: '/customer',
                icon: 'file-text',
                description: 'Manage your organization',
            },
            {
                name: 'Provider Groups',
                href: '/customer/provider-groups',
                icon: 'file-text',
                description: 'Manage provider groups',
            },
            {
                name: 'User Management',
                href: '/customer/users',
                icon: 'avatar',
                description: 'Manage organization users',
            },
            {
                name: 'Provider NPIs',
                href: '/customer/provider-npis',
                icon: 'id-card',
                description: 'Manage provider NPIs',
            },
            {
                name: 'eMDR',
                href: '/customer/emdr',
                icon: 'mail',
                description: 'Manage eMDR workflows',
            },
            {
                name: 'Letters',
                href: '/customer/letters',
                icon: 'file-text',
                description: 'All letters for your NPIs',
            },
        )
    }

    // Provider Group Admin
    if (userRoles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)) {
        navItems.push(
            {
                name: 'Provider Dashboard',
                href: '/provider',
                icon: 'file-text',
                description: 'Manage your provider group',
            },
            {
                name: 'Group Users',
                href: '/customer/users',
                icon: 'avatar',
                description: 'Manage group users',
            },
            {
                name: 'Provider NPIs',
                href: '/customer/provider-npis',
                icon: 'id-card',
                description: 'Manage provider NPIs',
            },
            {
                name: 'Letters',
                href: '/customer/letters',
                icon: 'file-text',
                description: 'All letters for your NPIs',
            },
        )
    }

    // Basic User
    if (userRoles.includes(INTEREX_ROLES.BASIC_USER)) {
        navItems.push(
            {
                name: 'Submissions',
                href: '/submissions',
                icon: 'file-text',
                description: 'Submit documentation',
            },
            {
                name: 'My NPIs',
                href: '/submissions/npis',
                icon: 'passkey',
                description: 'View assigned NPIs',
            },
            {
                name: 'Letters',
                href: '/customer/letters',
                icon: 'file-text',
                description: 'All letters for your NPIs',
            },
        )
    }

    return (
        <nav className="bg-white shadow-sm border-b">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex justify-between h-16">
                    <div className="flex">
                        <div className="flex-shrink-0 flex items-center">
                            <Link to="/" className="text-xl font-bold text-blue-600">
                                CMS Interex
                            </Link>
                        </div>
                        <div className="hidden sm:ml-6 sm:flex sm:space-x-8">
                            {navItems.map(item => {
                                const isActive = currentPath === item.href
                                return (
                                    <Link
                                        key={item.name}
                                        to={item.href}
                                        className={`inline-flex items-center px-1 pt-1 border-b-2 text-sm font-medium ${
                                            isActive
                                                ? 'border-blue-500 text-gray-900'
                                                : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                                        }`}
                                        title={item.description}
                                    >
                                        <Icon name={item.icon as any} className="w-4 h-4 mr-2" />
                                        {item.name}
                                    </Link>
                                )
                            })}
                        </div>
                    </div>
                    <div className="flex items-center">
                        <div className="flex-shrink-0">
              <span className="text-sm text-gray-500">
                {user.roles.map(r => r.name).join(', ')}
              </span>
                        </div>
                    </div>
                </div>
            </div>

            {/* Mobile menu */}
            <div className="sm:hidden">
                <div className="pt-2 pb-3 space-y-1">
                    {navItems.map(item => {
                        const isActive = currentPath === item.href
                        return (
                            <Link
                                key={item.name}
                                to={item.href}
                                className={`block pl-3 pr-4 py-2 border-l-4 text-base font-medium ${
                                    isActive
                                        ? 'bg-blue-50 border-blue-500 text-blue-700'
                                        : 'border-transparent text-gray-600 hover:bg-gray-50 hover:border-gray-300 hover:text-gray-800'
                                }`}
                            >
                                <div className="flex items-center">
                                    <Icon name={item.icon as any} className="w-4 h-4 mr-3" />
                                    <div>
                                        <div>{item.name}</div>
                                        <div className="text-xs text-gray-500">{item.description}</div>
                                    </div>
                                </div>
                            </Link>
                        )
                    })}
                </div>
            </div>
        </nav>
    )
}
