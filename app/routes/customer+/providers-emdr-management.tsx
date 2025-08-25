import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
    data,
    useLoaderData,
    useActionData,
    Form,
} from 'react-router'

import { InterexLayout } from '#app/components/interex-layout.tsx'
import { JsonViewer } from '#app/components/json-view.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { pcgGetProviders, type PcgProviderListItem } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

type Row = PcgProviderListItem & {
    customerName: string | null
    // prefer API provider_name, fall back to our local provider.name if missing
    provider_name: string | null
}

/** -------- Loader -------- */
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
    if (!customer) throw new Response('Customer not found', { status: 404 })

    // For now the admin is scoped to a single customer. Still shape it as options to support future multi-customer.
    const customerOptions = [{ id: customer.id, name: customer.name }]

    return data({
        user,
        customer,
        customerOptions,
    })
}

/** -------- Action -------- */
export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, roles: { select: { name: true } }, customerId: true },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })
    requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])
    if (!user.customerId) throw new Response('Customer admin must be linked to a customer', { status: 400 })

    const form = await request.formData()
    const intent = String(form.get('intent') || '')
    if (intent !== 'fetch') {
        return data({ error: 'Invalid action' }, { status: 400 })
    }

    // Selected customer (currently always the same as user.customerId, but keep flexible)
    const customerId = String(form.get('customerId') || user.customerId)

    const customer = await prisma.customer.findUnique({
        where: { id: customerId },
        select: { id: true, name: true },
    })
    if (!customer) {
        return data({ error: 'Customer not found.' }, { status: 404 })
    }

    // Pull local NPIs for this customer to restrict results
    const localProviders = await prisma.provider.findMany({
        where: { customerId },
        select: { npi: true, name: true },
    })
    const npiSet = new Set(localProviders.map(p => p.npi))
    const nameByNpi = new Map(localProviders.map(p => [p.npi, p.name ?? null] as const))

    // Fetch remote
    let pcgError: string | null = null
    let pcg = null as null | {
        listResponseModel: PcgProviderListItem[]
        totalResultCount: number
        page: number
        pageSize: number
    }
    try {
        const res = await pcgGetProviders()
        pcg = {
            listResponseModel: res.listResponseModel ?? [],
            totalResultCount: res.totalResultCount ?? (res.listResponseModel?.length || 0),
            page: res.page ?? 1,
            pageSize: res.pageSize ?? (res.listResponseModel?.length || 0),
        }
    } catch (err: any) {
        pcgError = err?.message || 'Failed to fetch providers from PCG.'
        pcg = { listResponseModel: [], totalResultCount: 0, page: 1, pageSize: 0 }
    }

    const rows: Row[] = (pcg.listResponseModel || [])
        .filter(r => npiSet.has(r.providerNPI))
        .map(r => ({
            ...r,
            customerName: customer.name,
            provider_name: r.provider_name ?? nameByNpi.get(r.providerNPI) ?? null,
        }))

    return data({
        rows,
        meta: {
            totalForOrg: rows.length,
            pcgTotal: pcg.totalResultCount,
            page: pcg.page,
            pageSize: pcg.pageSize,
        },
        pcgError,
        selectedCustomer: { id: customer.id, name: customer.name },
    })
}

/** -------- Client types for narrowing -------- */
type ActionSuccess = {
    rows: Row[]
    meta: { totalForOrg: number; pcgTotal: number; page: number; pageSize: number }
    pcgError: string | null
    selectedCustomer: { id: string; name: string }
}
type ActionFailure = { error: string }
type ActionData = ActionSuccess | ActionFailure

function Badge({ yes }: { yes: boolean }) {
    return (
        <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                yes ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
            }`}
        >
      {yes ? 'Yes' : 'No'}
    </span>
    )
}

/** -------- Component -------- */
export default function ProviderManagementPage() {
    const { user, customer, customerOptions } = useLoaderData<typeof loader>()
    const actionData = useActionData<ActionData>()
    const isPending = useIsPending()

    // Narrow the union safely:
    const hasRows = Boolean(actionData && 'rows' in actionData)

    const rows: Row[] = hasRows ? (actionData as ActionSuccess).rows : []
    const meta = hasRows ? (actionData as ActionSuccess).meta : undefined
    const pcgError = hasRows ? (actionData as ActionSuccess).pcgError : null
    const selectedCustomer = hasRows ? (actionData as ActionSuccess).selectedCustomer : customer

    return (
        <InterexLayout
            user={user}
            title="Provider Management & eMDR"
            subtitle={`Customer: ${customer?.name ?? ''}`}
            showBackButton
            backTo="/customer"
            currentPath="/customer/providers"
        >
            {/* Global pending overlay */}
            <LoadingOverlay show={Boolean(isPending)} title="Loading…" message="Please don't refresh or close this tab." />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
                {/* Filter + Fetch */}
                <div className="bg-white shadow rounded-lg p-6">
                    <Form method="post" className="flex items-end gap-4">
                        <div className="flex-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Customer</label>
                            <select
                                name="customerId"
                                defaultValue={customer.id}
                                className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                            >
                                {customerOptions.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <button
                            type="submit"
                            name="intent"
                            value="fetch"
                            className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                            disabled={isPending}
                        >
                            <Icon name="download" className="h-4 w-4 mr-2" />
                            Fetch from PCG
                        </button>
                    </Form>
                </div>

                {/* Error alert if PCG failed */}
                {pcgError ? (
                    <div className="rounded-md bg-amber-50 p-4 border border-amber-200">
                        <div className="flex">
                            <Icon name="question-mark-circled" className="h-5 w-5 text-amber-600 mt-0.5" />
                            <div className="ml-3 text-sm text-amber-800">{pcgError}</div>
                        </div>
                    </div>
                ) : null}

                {/* Table */}
                <div className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                        <div>
                            <h2 className="text-lg font-medium text-gray-900">eMDR Registration</h2>
                            <p className="text-sm text-gray-500">
                                {rows.length > 0 ? (
                                    <>
                                        Showing {rows.length} NPIs for <span className="font-medium">{selectedCustomer?.name}</span>
                                        {meta?.pcgTotal != null ? ` (PCG total: ${meta.pcgTotal})` : null}
                                    </>
                                ) : (
                                    <>
                                        Click “Fetch from PCG” to load providers for{' '}
                                        <span className="font-medium">{customer.name}</span>.
                                    </>
                                )}
                            </p>
                        </div>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider NPI</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Submitted Transaction</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Registered for eMDR</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Electronic Only?</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer Name</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider Name</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">City</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">ZIP</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">State</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Registration Status</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">JSON</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action</th>
                            </tr>
                            </thead>

                            <tbody className="bg-white divide-y divide-gray-200">
                            {rows.length === 0 ? (
                                <tr>
                                    <td colSpan={13} className="px-6 py-8 text-center text-sm text-gray-500">
                                        No data yet.
                                    </td>
                                </tr>
                            ) : (
                                rows.map((r: Row) => (
                                    <tr key={`${r.provider_id}-${r.providerNPI}`} className="hover:bg-gray-50 align-top">
                                        <td className="px-6 py-4 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{r.last_submitted_transaction ?? '—'}</td>
                                        <td className="px-6 py-4">
                                            <Badge yes={Boolean(r.registered_for_emdr)} />
                                        </td>
                                        <td className="px-6 py-4">
                                            <Badge yes={Boolean(r.registered_for_emdr_electronic_only)} />
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{r.customerName ?? '—'}</td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{r.provider_city ?? '—'}</td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{r.provider_zip ?? '—'}</td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{r.provider_state ?? '—'}</td>
                                        <td className="px-6 py-4">
                        <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                                r.reg_status === 'Registered'
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-gray-100 text-gray-800'
                            }`}
                        >
                          {r.reg_status ?? '—'}
                        </span>
                                        </td>
                                        <td className="px-6 py-4 text-sm text-gray-700">{r.provider_id}</td>

                                        {/* Wider JSON cell so expanded details are readable */}
                                        <td className="px-6 py-4 text-sm text-gray-700 align-top w-[40rem]">
                                            <JsonViewer data={r} />
                                        </td>

                                        {/* Action moved to far right */}
                                        <td className="px-6 py-4">
                                            <button
                                                type="button"
                                                title="Coming soon"
                                                className="inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                                                disabled
                                            >
                                                {r.reg_status === 'UnRegistered' ? 'Register' : 'Manage'}
                                            </button>
                                        </td>
                                    </tr>
                                ))
                            )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </InterexLayout>
    )
}
