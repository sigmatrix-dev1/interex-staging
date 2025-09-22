import { useState, useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router'
import { Icon } from '#app/components/ui/icon.tsx'
import { buildNavItems, type NavGroup, type NavLink } from '#app/utils/build-nav-items.ts'
import { type User } from '#app/utils/role-redirect.server.ts'

interface InterexNavigationProps {
    user: User
    currentPath?: string
}

export function InterexNavigation({ user, currentPath }: InterexNavigationProps) {
    const items = buildNavItems(user)
    const [openGroup, setOpenGroup] = useState<string | null>(null)
    const containerRef = useRef<HTMLDivElement | null>(null)

    const closeOnOutside = useCallback((e: MouseEvent) => {
        if (!containerRef.current) return
        if (!containerRef.current.contains(e.target as Node)) setOpenGroup(null)
    }, [])

    useEffect(() => {
        document.addEventListener('mousedown', closeOnOutside)
        return () => document.removeEventListener('mousedown', closeOnOutside)
    }, [closeOnOutside])

    useEffect(() => {
        // Close menu on route change
        setOpenGroup(null)
    }, [currentPath])

    const onKeyGroup = (e: React.KeyboardEvent, name: string) => {
        if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
            e.preventDefault()
            setOpenGroup(g => (g === name ? null : name))
        } else if (e.key === 'Escape') {
            setOpenGroup(null)
        }
    }

    const isLinkActive = (link: NavLink) => currentPath === link.href
    const groupHasActive = (group: NavGroup) => group.items.some(isLinkActive)

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
                            {items.map(item => {
                                if (item.type === 'link') {
                                    const link = item as NavLink
                                    const isActive = isLinkActive(link)
                                    return (
                                        <Link
                                            key={link.name}
                                            to={link.href}
                                            className={`inline-flex h-16 -mb-px items-center gap-2 px-3 border-b-2 text-sm font-medium transition-colors ${
                                                isActive
                                                    ? 'border-blue-500 text-gray-900'
                                                    : 'border-transparent text-gray-600 hover:text-gray-800 hover:border-gray-300'
                                            }`}
                                            title={link.description}
                                        >
                                            <Icon name={link.icon as any} className="w-4 h-4" />
                                            {link.name}
                                        </Link>
                                    )
                                }
                                const group = item as NavGroup
                                const active = groupHasActive(group)
                                const open = openGroup === group.name
                                return (
                                    <div key={group.name} className="relative" ref={open ? containerRef : undefined}>
                                        <button
                                            type="button"
                                            onClick={() => setOpenGroup(g => (g === group.name ? null : group.name))}
                                            onKeyDown={e => onKeyGroup(e, group.name)}
                                            aria-haspopup="menu"
                                            aria-expanded={open}
                                            className={`inline-flex h-16 -mb-px items-center gap-2 px-3 border-b-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:rounded ${
                                                active || open
                                                    ? 'border-blue-500 text-gray-900'
                                                    : 'border-transparent text-gray-600 hover:text-gray-800 hover:border-gray-300'
                                            }`}
                                        >
                                            <Icon name={group.icon as any} className="w-4 h-4" />
                                            {group.name}
                                            <Icon name="arrow-left" className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : '-rotate-90'}`} />
                                        </button>
                                        {open && (
                                            <div
                                                role="menu"
                                                className="absolute left-0 top-full min-w-[14rem] translate-y-px rounded-md border border-gray-200 bg-white shadow-lg z-20 py-1"
                                            >
                                                {group.items.map(child => {
                                                    const childActive = isLinkActive(child)
                                                    return (
                                                        <Link
                                                            key={child.name}
                                                            to={child.href}
                                                            role="menuitem"
                                                            className={`flex items-start gap-2 px-3 py-2 text-sm transition hover:bg-gray-50 focus:bg-gray-50 focus:outline-none ${
                                                                childActive ? 'text-blue-600 font-medium' : 'text-gray-700'
                                                            }`}
                                                        >
                                                            <Icon name={child.icon as any} className="w-4 h-4 mt-0.5" />
                                                            <div className="flex flex-col">
                                                                <span>{child.name}</span>
                                                                <span className="text-[11px] text-gray-500 leading-tight">{child.description}</span>
                                                            </div>
                                                        </Link>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
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
                    {items.map(item => {
                        if (item.type === 'link') {
                            const link = item as NavLink
                            const active = isLinkActive(link)
                            return (
                                <Link
                                    key={link.name}
                                    to={link.href}
                                    className={`block pl-3 pr-4 py-2 border-l-4 text-base font-medium ${
                                        active
                                            ? 'bg-blue-50 border-blue-500 text-blue-700'
                                            : 'border-transparent text-gray-600 hover:bg-gray-50 hover:border-gray-300 hover:text-gray-800'
                                    }`}
                                >
                                    <div className="flex items-center">
                                        <Icon name={link.icon as any} className="w-4 h-4 mr-3" />
                                        <div>
                                            <div>{link.name}</div>
                                            <div className="text-xs text-gray-500">{link.description}</div>
                                        </div>
                                    </div>
                                </Link>
                            )
                        }
                        const group = item as NavGroup
                        const active = groupHasActive(group)
                        return (
                            <div key={group.name} className="border-t first:border-t-0">
                                <button
                                    type="button"
                                    onClick={() => setOpenGroup(g => (g === group.name ? null : group.name))}
                                    className={`w-full flex items-center gap-2 pl-3 pr-4 py-2 text-left text-base font-medium ${
                                        active ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
                                    }`}
                                >
                                    <Icon name={group.icon as any} className="w-4 h-4" />
                                    <span className="flex-1">{group.name}</span>
                                    <Icon name="arrow-left" className={`w-4 h-4 transition-transform ${openGroup === group.name ? 'rotate-90' : '-rotate-90'}`} />
                                </button>
                                {openGroup === group.name && (
                                    <div className="pl-6 pb-2 space-y-1">
                                        {group.items.map(child => {
                                            const childActive = isLinkActive(child)
                                            return (
                                                <Link
                                                    key={child.name}
                                                    to={child.href}
                                                    className={`block pr-4 py-1 text-sm ${
                                                        childActive ? 'text-blue-600 font-medium' : 'text-gray-600 hover:text-gray-800'
                                                    }`}
                                                >
                                                    {child.name}
                                                </Link>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </div>
        </nav>
    )
}
