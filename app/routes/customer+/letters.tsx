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
        select: {
            id: true, name: true, customerId: true, providerGroupId: true,
            roles: { select: { name: true } },
        },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    const roles = user.roles.map(r => r.name)
    // Allow all three roles
    requireRoles(user, [
        INTEREX_ROLES.CUSTOMER_ADMIN,
        INTEREX_ROLES.PROVIDER_GROUP_ADMIN,
        INTEREX_ROLES.BASIC_USER,
    ])

    // Compute scope now (we’ll use this when we wire in data):
    let scope: 'CUSTOMER' | 'GROUP' | 'USER' = 'USER'
    if (roles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)) scope = 'CUSTOMER'
    else if (roles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)) scope = 'GROUP'

    // Minimal data to render the shell; queries will use scope later
    const customer = user.customerId
        ? await prisma.customer.findUnique({ where: { id: user.customerId }, select: { id: true, name: true } })
        : null

    return data({ user, scope, customer })
}

export default function LettersPage() {
    const { user, scope, customer } = useLoaderData<typeof loader>()

    const subtitle =
        scope === 'CUSTOMER'
            ? `All letters for NPIs under ${customer?.name ?? 'customer'}`
            : scope === 'GROUP'
                ? 'Letters for NPIs in your provider group'
                : 'Letters for your assigned NPIs'

    return (
        <InterexLayout
            user={user}
            title="Letters"
            subtitle={subtitle}
            showBackButton
            backTo={scope === 'CUSTOMER' ? '/customer' : scope === 'GROUP' ? '/provider' : '/submissions'}
            currentPath="/letters"
        >
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* TODO: Filters (NPI, status, date), table, letter viewer, actions */}
                <div className="bg-white shadow rounded-lg p-6">
                    <div className="flex items-center justify-between">
                        <h2 className="text-lg font-semibold text-gray-900">Coming soon</h2>
                    </div>
                    <p className="text-gray-600 mt-2">
                        This page will list letters based on your role scope:
                        <span className="ml-1 font-medium">{scope}</span>.
                    </p>
                </div>
            </div>
        </InterexLayout>
    )
}
