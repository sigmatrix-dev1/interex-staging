import { type LoaderFunctionArgs, data, useLoaderData  } from 'react-router'

import { InterexLayout } from '#app/components/interex-layout.tsx'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

export async function loader({ request }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, roles: { select: { name: true } }, customerId: true },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })
    requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])
    if (!user.customerId) throw new Response('Customer admin must be linked to a customer', { status: 400 })

    const customer = await prisma.customer.findUnique({
        where: { id: user.customerId },
        select: { id: true, name: true },
    })

    return data({ user, customer })
}

export default function ProviderManagementPage() {
    const { user, customer } = useLoaderData<typeof loader>()
    return (
        <InterexLayout
            user={user}
            title="Provider Management"
            subtitle={`Customer: ${customer?.name ?? ''}`}
            showBackButton
            backTo="/customer"
            currentPath="/customer/providers"
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* TODO: Build Provider Management features (distinct from Provider Groups / NPIs) */}
                <div className="bg-white shadow rounded-lg p-6">
                    <h2 className="text-lg font-semibold text-gray-900">Coming soon</h2>
                    <p className="text-gray-600 mt-2">
                        This module will centralize provider‑level configuration and metadata (beyond NPI and groups).
                    </p>
                </div>
            </div>
        </InterexLayout>
    )
}
