// app/routes/admin/providers-emdr-management.tsx

import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
    data,
    useLoaderData,
    useActionData,
    Form,
} from 'react-router'
import * as React from 'react'

import { InterexLayout } from '#app/components/interex-layout.tsx'
import { JsonViewer } from '#app/components/json-view.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import {
    pcgGetProviders,
    pcgUpdateProvider,
    type PcgProviderListItem,
    type PcgUpdateProviderPayload,
} from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { Drawer } from '#app/components/ui/drawer.tsx'

type Row = PcgProviderListItem & {
    customerName: string | null
    provider_name: string | null
    providerGroupName: string | null
}

type StoredUpdate = { npi: string; response: unknown | null }

/* ------------------------ Helpers (server) ------------------------ */

function toBaseRows(
    local: Array<{
        npi: string
        name: string | null
        providerStreet: string | null
        providerStreet2: string | null
        providerCity: string | null
        providerState: string | null
        providerZip: string | null
        pcgProviderId: string | null
        customerName: string | null
        providerGroupName: string | null
    }>,
): Row[] {
    return local
        .map(p => ({
            errorList: null,
            providerNPI: p.npi,
            last_submitted_transaction: null,
            status_changes: [],
            registered_for_emdr: false,
            provider_street: p.providerStreet,
            registered_for_emdr_electronic_only: false,
            provider_state: p.providerState,
            stage: null,
            notificationDetails: [],
            transaction_id_list: null,
            reg_status: null,
            provider_id: p.pcgProviderId || '',
            provider_city: p.providerCity,
            provider_zip: p.providerZip,
            provider_name: p.name ?? null,
            submission_status: null,
            errors: [],
            provider_street2: p.providerStreet2,
            esMDTransactionID: null,
            status: null,
            customerName: p.customerName,
            providerGroupName: p.providerGroupName,
        }))
        .sort((a, b) => a.providerNPI.localeCompare(b.providerNPI))
}

function mergeRemoteIntoBase(base: Row[], remote: PcgProviderListItem[]): Row[] {
    const byNpi = new Map(base.map(r => [r.providerNPI, r] as const))
    const result = base.map(r => ({ ...r }))
    for (const r of remote) {
        const idx = result.findIndex(x => x.providerNPI === r.providerNPI)
        const baseRow = byNpi.get(r.providerNPI)
        const merged: Row = {
            ...(baseRow as any),
            ...r,
            // prefer local (NPI table) values for these:
            provider_name: baseRow?.provider_name ?? r.provider_name ?? null,
            customerName: baseRow?.customerName ?? null,
            providerGroupName: baseRow?.providerGroupName ?? null,
        } as Row
        if (idx >= 0) result[idx] = merged
        else result.push(merged)
    }
    return result.sort((a, b) => a.providerNPI.localeCompare(b.providerNPI))
}

function buildUpdateFromRemote(r: PcgProviderListItem) {
    const u: Record<string, any> = {}
    if (r.provider_name !== undefined) u.name = r.provider_name ?? null
    if (r.provider_street !== undefined) u.providerStreet = r.provider_street ?? null
    if (r.provider_street2 !== undefined) u.providerStreet2 = r.provider_street2 ?? null
    if (r.provider_city !== undefined) u.providerCity = r.provider_city ?? null
    if (r.provider_state !== undefined) u.providerState = r.provider_state ?? null
    if (r.provider_zip !== undefined) u.providerZip = r.provider_zip ?? null
    if ((r as any).provider_id !== undefined) u.pcgProviderId = (r as any).provider_id ?? null
    return u
}

// Create or find the "System" customer for unassigned NPIs
async function getSystemCustomerId() {
    const existing = await prisma.customer.findFirst({ where: { name: 'System' }, select: { id: true } })
    if (existing) return existing.id
    const created = await prisma.customer.create({
        data: { name: 'System', description: 'Auto-created for unassigned providers from PCG list' },
        select: { id: true },
    })
    return created.id
}

// Get ALL pages of providers for the token
async function getAllProvidersFromPCG() {
    const pageSize = 500
    let page = 1
    let all: PcgProviderListItem[] = []
    // first page
    let res = await pcgGetProviders({ page, pageSize })
    all = all.concat(res.listResponseModel ?? [])
    const totalPages = Math.max(1, res.totalPages || 1)
    while (page < totalPages) {
        page++
        res = await pcgGetProviders({ page, pageSize })
        all = all.concat(res.listResponseModel ?? [])
    }
    return all
}

/* ----------------------------- Loader ----------------------------- */
/** System Admin: empty table until first Fetch */
export async function loader({ request }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, roles: { select: { name: true } } },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })
    requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

    return data({
        user,
        baseRows: [] as Row[],
        updateResponses: [] as StoredUpdate[],
    })
}

/* ----------------------------- Action ----------------------------- */
export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, roles: { select: { name: true } } },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })
    requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

    const form = await request.formData()
    const intent = String(form.get('intent') || '')

    async function loadAllLocal() {
        const localProviders = await prisma.provider.findMany({
            select: {
                npi: true,
                name: true,
                providerStreet: true,
                providerStreet2: true,
                providerCity: true,
                providerState: true,
                providerZip: true,
                pcgProviderId: true,
                pcgUpdateResponse: true,
                customer: { select: { name: true } },
                providerGroup: { select: { name: true } },
            },
            orderBy: [{ customerId: 'asc' }, { npi: 'asc' }],
        })
        const baseRows = toBaseRows(
            localProviders.map(p => ({
                npi: p.npi,
                name: p.name ?? null,
                providerStreet: p.providerStreet ?? null,
                providerStreet2: p.providerStreet2 ?? null,
                providerCity: p.providerCity ?? null,
                providerState: p.providerState ?? null,
                providerZip: p.providerZip ?? null,
                pcgProviderId: p.pcgProviderId ?? null,
                customerName: p.customer?.name ?? null,
                providerGroupName: p.providerGroup?.name ?? null,
            })),
        )
        const storedUpdates: StoredUpdate[] = localProviders.map(p => ({
            npi: p.npi,
            response: p.pcgUpdateResponse ?? null,
        }))
        return { baseRows, storedUpdates }
    }

    if (intent === 'fetch') {
        let pcgError: string | null = null
        let remote: PcgProviderListItem[] = []
        try {
            // 1) get *all* providers for token
            remote = await getAllProvidersFromPCG()

            // 2) persist: update existing, create new (under "System" customer),
            //    and snapshot raw list row for every remote item
            const systemCustomerId = await getSystemCustomerId()
            const existing = await prisma.provider.findMany({
                where: { npi: { in: remote.map(r => r.providerNPI) } },
                select: { npi: true },
            })
            const existingSet = new Set(existing.map(p => p.npi))
            const now = new Date()

            // batch updates
            const updates = remote.filter(r => existingSet.has(r.providerNPI))
            const creates = remote.filter(r => !existingSet.has(r.providerNPI))

            // Chunk to keep transaction size sane
            const chunk = <T,>(arr: T[], size: number) =>
                Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size))

            // Updates
            for (const group of chunk(updates, 100)) {
                await prisma.$transaction(
                    group.map(r =>
                        prisma.provider.update({
                            where: { npi: r.providerNPI },
                            data: {
                                ...buildUpdateFromRemote(r),
                                pcgListSnapshot: r as any,
                                pcgListAt: now,
                            },
                        }),
                    ),
                )
            }

            // Creates (under "System")
            for (const group of chunk(creates, 50)) {
                await prisma.$transaction(
                    group.map(r =>
                        prisma.provider.create({
                            data: {
                                npi: r.providerNPI,
                                customerId: systemCustomerId,
                                name: r.provider_name ?? null,
                                providerStreet: r.provider_street ?? null,
                                providerStreet2: r.provider_street2 ?? null,
                                providerCity: r.provider_city ?? null,
                                providerState: r.provider_state ?? null,
                                providerZip: r.provider_zip ?? null,
                                pcgProviderId: (r as any).provider_id ?? null,
                                pcgListSnapshot: r as any,
                                pcgListAt: now,
                            },
                        }),
                    ),
                )
            }
        } catch (err: any) {
            pcgError = err?.message || 'Failed to fetch providers from PCG.'
        }

        // Rebuild local rows from DB + merge remote for display
        const { baseRows, storedUpdates } = await loadAllLocal()
        const rows = mergeRemoteIntoBase(baseRows, remote)

        return data({
            rows,
            meta: { totalForOrg: rows.length },
            pcgError,
            didUpdate: false as const,
            updatedNpi: undefined,
            updateResponse: undefined,
            updateResponses: storedUpdates,
        })
    }

    if (intent === 'update-provider') {
        const payload: PcgUpdateProviderPayload = {
            provider_name: String(form.get('provider_name') || '').trim(),
            provider_npi: String(form.get('provider_npi') || '').trim(),
            provider_street: String(form.get('provider_street') || '').trim(),
            provider_street2: String(form.get('provider_street2') || '').trim(),
            provider_city: String(form.get('provider_city') || '').trim(),
            provider_state: String(form.get('provider_state') || '').trim().toUpperCase(),
            provider_zip: String(form.get('provider_zip') || '').trim(),
        }

        const missing = ([
            'provider_name',
            'provider_npi',
            'provider_street',
            'provider_city',
            'provider_state',
            'provider_zip',
        ] as const).filter(k => !payload[k])
        if (missing.length) {
            return data({ error: `Missing fields: ${missing.join(', ')}` }, { status: 400 })
        }

        let pcgError: string | null = null
        let didUpdate = false
        let updateResponse: any = null
        try {
            // Call PCG
            updateResponse = await pcgUpdateProvider(payload)
            didUpdate = true

            // Persist locally if NPI exists (it should, after fetch)
            const existing = await prisma.provider.findUnique({ where: { npi: payload.provider_npi }, select: { id: true } })
            if (existing) {
                await prisma.provider.update({
                    where: { id: existing.id },
                    data: {
                        name: payload.provider_name,
                        providerStreet: payload.provider_street || null,
                        providerStreet2: payload.provider_street2 || null,
                        providerCity: payload.provider_city || null,
                        providerState: payload.provider_state || null,
                        providerZip: payload.provider_zip || null,
                        pcgProviderId: updateResponse?.provider_id ?? undefined,
                        pcgUpdateResponse: updateResponse,
                        pcgUpdateAt: new Date(),
                    },
                })
            }
        } catch (err: any) {
            pcgError = err?.message || 'Failed to update provider.'
        }

        // Refresh full remote list and align DB (also snapshot)
        let remote: PcgProviderListItem[] = []
        try {
            remote = await getAllProvidersFromPCG()
            const now = new Date()
            const existing = await prisma.provider.findMany({
                where: { npi: { in: remote.map(r => r.providerNPI) } },
                select: { npi: true },
            })
            const existingSet = new Set(existing.map(p => p.npi))
            const updates = remote.filter(r => existingSet.has(r.providerNPI))

            const chunk = <T,>(arr: T[], size: number) =>
                Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size))

            for (const group of chunk(updates, 100)) {
                await prisma.$transaction(
                    group.map(r =>
                        prisma.provider.update({
                            where: { npi: r.providerNPI },
                            data: {
                                ...buildUpdateFromRemote(r),
                                pcgListSnapshot: r as any,
                                pcgListAt: now,
                            },
                        }),
                    ),
                )
            }
        } catch {
            // ignore
        }

        const { baseRows, storedUpdates } = await loadAllLocal()
        const rows = mergeRemoteIntoBase(baseRows, remote)

        return data({
            rows,
            meta: { totalForOrg: rows.length },
            pcgError,
            didUpdate,
            updatedNpi: payload.provider_npi,
            updateResponse,
            updateResponses: storedUpdates,
        })
    }

    return data({ error: 'Invalid action' }, { status: 400 })
}

/* ------------------------- Client-side types ------------------------- */
type ActionSuccess = {
    rows: Row[]
    meta: { totalForOrg: number }
    pcgError: string | null
    didUpdate?: boolean
    updatedNpi?: string
    updateResponse?: any
    updateResponses?: { npi: string; response: unknown | null }[]
}
type ActionFailure = { error: string }
type ActionData = ActionSuccess | ActionFailure

function Badge({ yes }: { yes: boolean }) {
    const cls = yes
        ? 'bg-green-100 text-green-800 ring-1 ring-green-300'
        : 'bg-gray-100 text-gray-800 ring-1 ring-gray-300'
    return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>{yes ? 'Yes' : 'No'}</span>
}

function Pill({ text }: { text: string }) {
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 ring-1 ring-blue-200">{text}</span>
}

/* ------------------------------ Component ------------------------------ */
export default function ProviderManagementPage() {
    const { user, baseRows, updateResponses } = useLoaderData<{
        user: any
        baseRows: Row[]
        updateResponses: StoredUpdate[]
    }>()
    const actionData = useActionData<ActionData>()
    const isPending = useIsPending()

    const hasRows = Boolean(actionData && 'rows' in actionData)
    const rows: Row[] = hasRows ? (actionData as ActionSuccess).rows : baseRows
    const pcgError = hasRows ? (actionData as ActionSuccess).pcgError : null

    // Update response sources
    const lastUpdatedNpi = hasRows ? (actionData as ActionSuccess).updatedNpi : undefined
    const lastUpdateResponse = hasRows ? (actionData as ActionSuccess).updateResponse : undefined
    const persistedMap = React.useMemo(() => {
        const m = new Map<string, unknown | null>()
        ;(hasRows ? (actionData as ActionSuccess).updateResponses ?? updateResponses : updateResponses).forEach(
            u => m.set(u.npi, u.response),
        )
        return m
    }, [hasRows, actionData, updateResponses])

    // Client-side customer filter (derived from the table)
    const [customerFilter, setCustomerFilter] = React.useState<'all' | 'unassigned' | string>('all')
    const customerChoices = React.useMemo(() => {
        const names = new Set<string>()
        rows.forEach(r => {
            if (r.customerName && r.customerName.trim()) names.add(r.customerName.trim())
        })
        return Array.from(names).sort()
    }, [rows])

    const filteredRows = React.useMemo(() => {
        if (!hasRows) return [] // nothing until fetched
        if (customerFilter === 'all') return rows
        if (customerFilter === 'unassigned') return rows.filter(r => !r.customerName)
        return rows.filter(r => r.customerName === customerFilter)
    }, [rows, customerFilter, hasRows])

    // Drawer state
    const [drawer, setDrawer] = React.useState<{
        open: boolean
        forNpi?: string
        seed?: Partial<PcgUpdateProviderPayload>
    }>({ open: false })

    function openDrawer(r: Row) {
        setDrawer({
            open: true,
            forNpi: r.providerNPI,
            seed: {
                provider_name: r.provider_name ?? '',
                provider_npi: r.providerNPI,
                provider_street: r.provider_street ?? '',
                provider_street2: r.provider_street2 ?? '',
                provider_city: r.provider_city ?? '',
                provider_state: r.provider_state ?? '',
                provider_zip: r.provider_zip ?? '',
            },
        })
    }
    function closeDrawer() {
        setDrawer({ open: false })
    }

    React.useEffect(() => {
        if (hasRows) {
            const a = actionData as ActionSuccess
            if (a?.didUpdate && !a?.pcgError && drawer.open) setDrawer({ open: false })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [actionData])

    return (
        <InterexLayout
            user={user}
            title="Provider Management & eMDR"
            subtitle="System Admin • Full-token provider list"
            showBackButton
            backTo="/admin/dashboard"
            currentPath="/admin/providers-emdr-management"
        >
            <LoadingOverlay show={Boolean(isPending)} title="Loading…" message="Please don't refresh or close this tab." />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
                {/* Fetch & Filter */}
                <div className="bg-white shadow rounded-lg p-6">
                    <div className="flex items-end gap-4">
                        <Form method="post">
                            <input type="hidden" name="intent" value="fetch" />
                            <button
                                type="submit"
                                className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                                disabled={isPending}
                            >
                                <Icon name="download" className="h-4 w-4 mr-2" />
                                Fetch from PCG
                            </button>
                        </Form>

                        {/* Customer filter (built from the fetched table) */}
                        <div className="flex-1" />
                        <div className="w-72">
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Filter by Customer (from table)
                            </label>
                            <select
                                value={customerFilter}
                                onChange={e => setCustomerFilter(e.target.value as any)}
                                disabled={!hasRows}
                                className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
                            >
                                <option value="all">All Customers</option>
                                <option value="unassigned">Unassigned</option>
                                {customerChoices.map(name => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    {!hasRows ? (
                        <p className="mt-3 text-sm text-gray-500">Click “Fetch from PCG” to load providers for this token.</p>
                    ) : (
                        <p className="mt-3 text-sm text-gray-500">
                            Showing {filteredRows.length} of {rows.length} NPIs
                            {customerFilter === 'all'
                                ? ''
                                : customerFilter === 'unassigned'
                                    ? ' • Unassigned'
                                    : ` • ${customerFilter}`}
                        </p>
                    )}
                </div>

                {/* Error alert if PCG failed */}
                {pcgError ? (
                    <div className="rounded-md bg-amber-50 p-4 border border-amber-200">
                        <div className="flex">
                            <Icon name="warning-triangle" className="h-5 w-5 text-amber-600 mt-0.5" />
                            <div className="ml-3 text-sm text-amber-800">{pcgError}</div>
                        </div>
                    </div>
                ) : null}

                {/* Table */}
                <div className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <h2 className="text-lg font-medium text-gray-900">eMDR Registration</h2>
                        <p className="text-sm text-gray-500">
                            {hasRows ? (
                                <>
                                    Showing {filteredRows.length} NPIs • Filter:&nbsp;
                                    <span className="font-medium">
                    {customerFilter === 'all'
                        ? 'All Customers'
                        : customerFilter === 'unassigned'
                            ? 'Unassigned'
                            : customerFilter}
                  </span>
                                </>
                            ) : (
                                'No data loaded'
                            )}
                        </p>
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
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider Group</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider Name</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Street</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Street 2</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">City</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">ZIP</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">State</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Registration Status</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider ID</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">JSON</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Update Provider</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Update Response</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider ID (Post Update)</th>
                            </tr>
                            </thead>

                            <tbody className="bg-white divide-y divide-gray-200">
                            {!hasRows || filteredRows.length === 0 ? (
                                <tr>
                                    <td colSpan={18} className="px-6 py-8 text-center text-sm text-gray-500">
                                        {hasRows ? 'No rows match this filter.' : 'No data.'}
                                    </td>
                                </tr>
                            ) : (
                                filteredRows.map((r: Row) => {
                                    const actionJson = lastUpdatedNpi === r.providerNPI ? lastUpdateResponse : undefined
                                    const persistedJson = persistedMap.get(r.providerNPI)
                                    const jsonToShow = actionJson ?? persistedJson ?? null

                                    const providerIdPostUpdate =
                                        jsonToShow && typeof jsonToShow === 'object' && (jsonToShow as any).provider_id
                                            ? String((jsonToShow as any).provider_id)
                                            : ''

                                    const regStatusClass =
                                        r.reg_status?.toLowerCase().includes('register') ? 'bg-green-100 text-green-800' :
                                            r.reg_status ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-800'

                                    return (
                                        <tr key={`${r.provider_id}-${r.providerNPI}`} className="hover:bg-gray-50 align-top">
                                            <td className="px-6 py-4 text-sm font-medium text-gray-900">{r.providerNPI}</td>

                                            <td className="px-6 py-4 text-sm">
                                                {r.last_submitted_transaction
                                                    ? <Pill text={r.last_submitted_transaction} />
                                                    : <span className="text-gray-400">—</span>}
                                            </td>

                                            <td className="px-6 py-4">
                                                <Badge yes={Boolean(r.registered_for_emdr)} />
                                            </td>

                                            <td className="px-6 py-4">
                                                <Badge yes={Boolean(r.registered_for_emdr_electronic_only)} />
                                            </td>

                                            <td className="px-6 py-4 text-sm text-gray-700">{r.customerName ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.providerGroupName ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700 break-words">{r.provider_street ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700 break-words">{r.provider_street2 ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_city ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_zip ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_state ?? '—'}</td>

                                            <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${regStatusClass}`}>
                            {r.reg_status ?? '—'}
                          </span>
                                            </td>

                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_id || '—'}</td>

                                            <td className="px-6 py-4 text-sm text-gray-700 align-top w-[40rem]">
                                                <JsonViewer data={r} />
                                            </td>

                                            <td className="px-6 py-4">
                                                <button
                                                    type="button"
                                                    onClick={() => openDrawer(r)}
                                                    className="inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                                                    disabled={isPending}
                                                >
                                                    Update Provider Details
                                                </button>
                                            </td>

                                            <td className="px-6 py-4 text-sm text-gray-700 align-top w-[36rem]">
                                                {jsonToShow ? <JsonViewer data={jsonToShow} /> : <span className="text-gray-400">—</span>}
                                            </td>

                                            <td className="px-6 py-4 text-sm text-gray-700">
                                                {providerIdPostUpdate ? <Pill text={providerIdPostUpdate} /> : <span className="text-gray-400">—</span>}
                                            </td>
                                        </tr>
                                    )
                                })
                            )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Drawer */}
            <Drawer
                isOpen={drawer.open}
                onClose={closeDrawer}
                title={`Update Provider • NPI ${drawer.seed?.provider_npi ?? drawer.forNpi ?? ''}`}
                size="md"
            >
                {drawer.open ? (
                    <Form method="post" className="space-y-5">
                        <input type="hidden" name="intent" value="update-provider" />

                        <div>
                            <label className="block text-sm font-medium text-gray-700">Provider NPI</label>
                            <input
                                name="provider_npi"
                                value={drawer.seed?.provider_npi ?? ''}
                                readOnly
                                className="mt-1 block w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600"
                            />
                            <p className="mt-1 text-xs text-gray-500">Auto-derived from the row.</p>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700">Provider Name</label>
                            <input
                                name="provider_name"
                                defaultValue={drawer.seed?.provider_name ?? ''}
                                required
                                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                                placeholder="e.g., Smith Clinic"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700">Street</label>
                            <input
                                name="provider_street"
                                defaultValue={drawer.seed?.provider_street ?? ''}
                                required
                                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                                placeholder="123 Main St"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700">Street 2 (optional)</label>
                            <input
                                name="provider_street2"
                                defaultValue={drawer.seed?.provider_street2 ?? ''}
                                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                                placeholder="Suite / Apt"
                            />
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div>
                                <label className="block text-sm font-medium text-gray-700">City</label>
                                <input
                                    name="provider_city"
                                    defaultValue={drawer.seed?.provider_city ?? ''}
                                    required
                                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700">State</label>
                                <input
                                    name="provider_state"
                                    defaultValue={drawer.seed?.provider_state ?? ''}
                                    required
                                    maxLength={2}
                                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm uppercase"
                                    placeholder="MD"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700">ZIP</label>
                                <input
                                    name="provider_zip"
                                    defaultValue={drawer.seed?.provider_zip ?? ''}
                                    required
                                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                                    placeholder="12345"
                                />
                            </div>
                        </div>

                        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                            <button
                                type="button"
                                onClick={closeDrawer}
                                className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                disabled={isPending}
                                className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
                            >
                                Submit
                            </button>
                        </div>
                    </Form>
                ) : null}
            </Drawer>
        </InterexLayout>
    )
}
