// app/routes/my-npis.tsx
import * as React from 'react'
import {
    type LoaderFunctionArgs,
    data,
    useLoaderData,
    Link,
} from 'react-router'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useToast } from '#app/components/toaster.tsx'

export async function loader({ request }: LoaderFunctionArgs) {
    const [{ requireUserId }, { prisma }, { requireRoles }, { getToast }] = await Promise.all([
        import('#app/utils/auth.server.ts'),
        import('#app/utils/db.server.ts'),
        import('#app/utils/role-redirect.server.ts'),
        import('#app/utils/toast.server.ts'),
    ])

    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            email: true,
            username: true,
            customerId: true,
            roles: { select: { name: true } },
        },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    // Allow Basic User (and above) to access this page
    requireRoles(user, [
        INTEREX_ROLES.BASIC_USER,
        INTEREX_ROLES.PROVIDER_GROUP_ADMIN,
        INTEREX_ROLES.CUSTOMER_ADMIN,
        INTEREX_ROLES.SYSTEM_ADMIN,
    ])
    if (!user.customerId) throw new Response('User must be associated with a customer', { status: 400 })

    // Only show providers explicitly assigned to this user, scoped to their customer
    const providers = await prisma.provider.findMany({
        where: {
            customerId: user.customerId,
            userNpis: { some: { userId: user.id } },
        },
        include: {
            providerGroup: { select: { id: true, name: true } },
        },
        orderBy: { npi: 'asc' },
    })

    // Fetch customer name for header
    const customer = await prisma.customer.findUnique({
        where: { id: user.customerId },
        select: { id: true, name: true },
    })

    const { toast, headers } = await getToast(request)
    return data(
        {
            user,
            customer,
            providers,
            toast,
        },
        { headers: headers ?? undefined },
    )
}

export default function MyNpisPage() {
    const { user, customer, providers, toast } = useLoaderData<typeof loader>()
    const isPending = useIsPending()
    useToast(toast)

    React.useEffect(() => {
        const headers = Array.from(document.querySelectorAll('header')) as HTMLElement[]
        // If there are 2 headers, the first is the outer brand bar; hide just that one.
        const outer = headers.length > 1 ? headers[0] : null
        let prevDisplay: string | null = null
        if (outer) {
            prevDisplay = outer.style.display || ''
            outer.style.display = 'none'
        }
        return () => {
            if (outer) outer.style.display = prevDisplay ?? ''
        }
    }, [])

    return (
        <InterexLayout
            user={user}
            title="My NPIs"
            subtitle={`Assigned to you • ${customer?.name ?? '—'}`}
            showBackButton
            backTo="/customer/submissions"
            currentPath="/my-npis"
        >
            <LoadingOverlay show={Boolean(isPending)} title="Loading…" message="Please don't refresh or close this tab." />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
                {/* List */}
                <div className="bg-white shadow rounded-lg">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <div className="flex items-center justify-between">
                            <div>
                                <h2 className="text-lg font-medium text-gray-900">Assigned NPIs</h2>
                                <p className="text-sm text-gray-500">
                                    {providers.length} NPI{providers.length === 1 ? '' : 's'} found
                                </p>
                            </div>
                            <div className="text-xs text-gray-500">Read-only • scoped to your assignments</div>
                        </div>
                    </div>

                    {providers.length === 0 ? (
                        <div className="px-6 py-12 text-center">
                            <Icon name="id-card" className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                            <h3 className="text-lg font-medium text-gray-900 mb-2">No NPIs assigned to you</h3>
                            <p className="text-gray-500">
                                If you believe this is an error, please contact your administrator.
                            </p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">NPI</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider Name</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Provider Group</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Quick Links</th>
                                </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                {providers.map(p => (
                                    <tr key={p.id} className="hover:bg-gray-50">
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="text-sm font-medium text-gray-900">{p.npi}</div>
                                        </td>
                                        <td className="px-6 py-4">
                                            <div className="text-sm text-gray-900">{p.name || 'No name'}</div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                                            <div className="text-sm text-gray-900">{p.providerGroup?.name || 'No group'}</div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap">
                        <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                p.active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                            }`}
                        >
                          {p.active ? 'Active' : 'Inactive'}
                        </span>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm">
                                            <div className="flex items-center gap-2">
                                                <Link
                                                    to={`/customer/provider-npis?search=${encodeURIComponent(p.npi)}`}
                                                    className="inline-flex items-center px-2 py-1 rounded-md text-blue-700 hover:text-blue-900 hover:bg-blue-50"
                                                    title="Open in Provider Management"
                                                >
                                                    <Icon name="link-2" className="h-4 w-4 mr-1" />
                                                    Manage
                                                </Link>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </InterexLayout>
    )
}
