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
    pcgSetEmdrRegistration,
    pcgSetElectronicOnly,
    pcgGetProviderRegistration, // NEW
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
type RegResp = Awaited<ReturnType<typeof pcgGetProviderRegistration>>

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

// Server-side prereq check for eMDR actions
function hasEmdrPrereqsServer(p: {
    name: string | null
    providerStreet: string | null
    providerCity: string | null
    providerState: string | null
    providerZip: string | null
}) {
    return Boolean(
        (p.name ?? '').trim() &&
        (p.providerStreet ?? '').trim() &&
        (p.providerCity ?? '').trim() &&
        (p.providerState ?? '').trim() &&
        (p.providerZip ?? '').trim(),
    )
}

/* ----------------------------- Loader ----------------------------- */
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
            remote = await getAllProvidersFromPCG()

            const systemCustomerId = await getSystemCustomerId()
            const existing = await prisma.provider.findMany({
                where: { npi: { in: remote.map(r => r.providerNPI) } },
                select: { npi: true },
            })
            const existingSet = new Set(existing.map(p => p.npi))
            const now = new Date()

            const updates = remote.filter(r => existingSet.has(r.providerNPI))
            const creates = remote.filter(r => !existingSet.has(r.providerNPI))

            const chunk = <T,>(arr: T[], size: number) =>
                Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size))

            for (const group of chunk(updates, 100)) {
                await prisma.$transaction(
                    group.map(r =>
                        prisma.provider.update({
                            where: { npi: r.providerNPI },
                            data: { ...buildUpdateFromRemote(r), pcgListSnapshot: r as any, pcgListAt: now },
                        }),
                    ),
                )
            }

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
        if (missing.length) return data({ error: `Missing fields: ${missing.join(', ')}` }, { status: 400 })

        let pcgError: string | null = null
        let didUpdate = false
        let updateResponse: any = null
        try {
            updateResponse = await pcgUpdateProvider(payload)
            didUpdate = true

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
                            data: { ...buildUpdateFromRemote(r), pcgListSnapshot: r as any, pcgListAt: now },
                        }),
                    ),
                )
            }
        } catch { /* ignore */ }

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

    // --- Bulk fetch per-provider registration details --------------------------
    if (intent === 'fetch-registrations') {
        const nowIso = new Date().toISOString()

        // Only providers with provider_id and required address/name
        const candidates = await prisma.provider.findMany({
            where: {
                NOT: [
                    { pcgProviderId: null },
                    { pcgProviderId: '' },
                    { name: null },
                    { providerStreet: null },
                    { providerCity: null },
                    { providerState: null },
                    { providerZip: null },
                ],
            },
            select: {
                npi: true,
                pcgProviderId: true,
                name: true,
                providerStreet: true,
                providerCity: true,
                providerState: true,
                providerZip: true,
            },
        })

        const regById: Record<string, RegResp> = Object.create(null)
        const chunk = <T,>(arr: T[], size: number) =>
            Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * size))

        for (const group of chunk(candidates, 20)) {
            for (const c of group) {
                try {
                    const data = await pcgGetProviderRegistration(c.pcgProviderId!)
                    regById[c.pcgProviderId!] = data
                } catch (err: any) {
                    regById[c.pcgProviderId!] = {
                        providerNPI: c.npi,
                        errorList: [err?.message ?? 'Failed to fetch registration'],
                        status_changes: [],
                        provider_street: null,
                        call_error_description: err?.message ?? 'Unknown error',
                        provider_state: null,
                        stage: null,
                        transaction_id_list: null,
                        reg_status: null,
                        provider_id: c.pcgProviderId!,
                        provider_city: null,
                        provider_zip: null,
                        provider_name: null,
                        call_error_code: 'FETCH_ERROR',
                        submission_status: null,
                        errors: [],
                        provider_street2: null,
                        status: null,
                    } as any
                }
            }
        }

        // Compose latest rows view
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

        let remote: PcgProviderListItem[] = []
        try { remote = await getAllProvidersFromPCG() } catch { /* ignore */ }
        const rows = mergeRemoteIntoBase(baseRows, remote)

        return data({
            rows,
            meta: { totalForOrg: rows.length },
            pcgError: null,
            didUpdate: false as const,
            updatedNpi: undefined,
            updateResponse: undefined,
            updateResponses: [],
            regById,
            regFetchedAt: nowIso,
        })
    }

    // --- eMDR Register / DeRegister / Electronic Only --------------------------
    if (intent === 'emdr-register' || intent === 'emdr-deregister' || intent === 'emdr-electronic-only') {
        const providerId = String(form.get('provider_id') || '').trim()
        const providerNpi = String(form.get('provider_npi') || '').trim()
        if (!providerId) {
            return data({ error: 'Missing provider_id. Update Provider first to obtain a Provider ID.' }, { status: 400 })
        }

        let pcgError: string | null = null
        let updateResponse: any = null

        try {
            if (intent === 'emdr-register') updateResponse = await pcgSetEmdrRegistration(providerId, true)
            else if (intent === 'emdr-deregister') updateResponse = await pcgSetEmdrRegistration(providerId, false)
            else updateResponse = await pcgSetElectronicOnly(providerId)

            const existing = await prisma.provider.findUnique({ where: { npi: providerNpi }, select: { id: true } })
            if (existing) {
                await prisma.provider.update({
                    where: { id: existing.id },
                    data: {
                        pcgUpdateResponse: updateResponse,
                        pcgUpdateAt: new Date(),
                        pcgProviderId: updateResponse?.provider_id ?? undefined,
                    },
                })
            }
        } catch (err: any) {
            pcgError = err?.message || 'Failed to submit eMDR registration/deregistration.'
        }

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
                            data: { ...buildUpdateFromRemote(r), pcgListSnapshot: r as any, pcgListAt: now },
                        }),
                    ),
                )
            }
        } catch { /* ignore snapshot failures */ }

        const { baseRows, storedUpdates } = await loadAllLocal()
        const rows = mergeRemoteIntoBase(baseRows, remote)

        return data({
            rows,
            meta: { totalForOrg: rows.length },
            pcgError,
            didUpdate: false as const,
            updatedNpi: providerNpi,
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

    regById?: Record<string, RegResp>
    regFetchedAt?: string
}
type ActionFailure = { error: string }
type ActionData = ActionSuccess | ActionFailure

function Badge({ yes }: { yes: boolean }) {
    const cls = yes ? 'bg-green-100 text-green-800 ring-1 ring-green-300' : 'bg-gray-100 text-gray-800 ring-1 ring-gray-300'
    return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>{yes ? 'Yes' : 'No'}</span>
}
function Pill({ text }: { text: string }) {
    return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 ring-1 ring-blue-200">{text}</span>
}

/** Confirm-with-checkbox wrapper for eMDR actions */
function ConfirmActionButton({
                                 intent,
                                 providerId,
                                 providerNpi,
                                 label,
                                 color = 'blue',
                                 disabled,
                                 warning,
                             }: {
    intent: 'emdr-register' | 'emdr-deregister' | 'emdr-electronic-only'
    providerId?: string
    providerNpi: string
    label: string
    color?: 'blue' | 'green' | 'rose' | 'purple'
    disabled?: boolean
    warning: string
}) {
    const [open, setOpen] = React.useState(false)
    const [checked, setChecked] = React.useState(false)
    const colorClass =
        color === 'green' ? 'bg-green-600 hover:bg-green-700'
            : color === 'rose' ? 'bg-rose-600 hover:bg-rose-700'
                : color === 'purple' ? 'bg-purple-600 hover:bg-purple-700'
                    : 'bg-blue-600 hover:bg-blue-700'

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm disabled:opacity-50 ${colorClass}`}
                disabled={disabled}
            >
                {label}
            </button>
        )
    }

    return (
        <div className="rounded-md border p-3 space-y-2 bg-gray-50 max-w-sm">
            <div className="flex gap-2 text-sm text-gray-800">
                <Icon name="warning-triangle" className="h-4 w-4 text-amber-600 mt-0.5" />
                <div>{warning}</div>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-700">
                <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    checked={checked}
                    onChange={e => setChecked(e.target.checked)}
                />
                I understand and want to proceed.
            </label>
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={() => {
                        setOpen(false)
                        setChecked(false)
                    }}
                    className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                >
                    Cancel
                </button>
                <Form method="post">
                    <input type="hidden" name="intent" value={intent} />
                    <input type="hidden" name="provider_id" value={providerId || ''} />
                    <input type="hidden" name="provider_npi" value={providerNpi} />
                    <button
                        type="submit"
                        disabled={!checked || disabled || !providerId}
                        className={`inline-flex items-center rounded-md px-3 py-1.5 text-xs font-semibold text-white shadow-sm disabled:opacity-50 ${colorClass}`}
                        title={!providerId ? 'Provider ID required' : label}
                    >
                        Proceed
                    </button>
                </Form>
            </div>
        </div>
    )
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

    // Action response sources (last vs. persisted)
    const lastUpdatedNpi = hasRows ? (actionData as ActionSuccess).updatedNpi : undefined
    const lastUpdateResponse = hasRows ? (actionData as ActionSuccess).updateResponse : undefined
    const persistedMap = React.useMemo(() => {
        const m = new Map<string, unknown | null>()
        ;(hasRows ? (actionData as ActionSuccess).updateResponses ?? updateResponses : updateResponses).forEach(
            u => m.set(u.npi, u.response),
        )
        return m
    }, [hasRows, actionData, updateResponses])

    // Registration details (ephemeral)
    const regById = (hasRows ? (actionData as ActionSuccess).regById : undefined) || {}
    const regFetchedAt = hasRows ? (actionData as ActionSuccess).regFetchedAt : undefined

    // Client-side customer filter
    const [customerFilter, setCustomerFilter] = React.useState<'all' | 'unassigned' | string>('all')
    const customerChoices = React.useMemo(() => {
        const names = new Set<string>()
        rows.forEach(r => {
            if (r.customerName && r.customerName.trim()) names.add(r.customerName.trim())
        })
        return Array.from(names).sort()
    }, [rows])

    const filteredRows = React.useMemo(() => {
        if (!hasRows) return []
        if (customerFilter === 'all') return rows
        if (customerFilter === 'unassigned') return rows.filter(r => !r.customerName)
        return rows.filter(r => r.customerName === customerFilter)
    }, [rows, customerFilter, hasRows])

    // Drawer state
    const [drawer, setDrawer] = React.useState<{ open: boolean; forNpi?: string; seed?: Partial<PcgUpdateProviderPayload> }>({ open: false })
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
    function closeDrawer() { setDrawer({ open: false }) }

    React.useEffect(() => {
        if (hasRows) {
            const a = actionData as ActionSuccess
            if (a?.didUpdate && !a?.pcgError && drawer.open) setDrawer({ open: false })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [actionData])

    function ActionResponseCell({ r }: { r: Row }) {
        const actionJson = lastUpdatedNpi === r.providerNPI ? lastUpdateResponse : undefined
        const persistedJson = persistedMap.get(r.providerNPI)
        const jsonToShow = actionJson ?? persistedJson ?? null
        return jsonToShow ? <JsonViewer data={jsonToShow} /> : <span className="text-gray-400">—</span>
    }

    function RegStatusPill({ r, reg }: { r: Row; reg?: RegResp }) {
        const val = reg?.reg_status ?? r.reg_status
        const cls =
            val?.toLowerCase().includes('register') ? 'bg-green-100 text-green-800'
                : val ? 'bg-amber-100 text-amber-800'
                    : 'bg-gray-100 text-gray-800'
        return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>{val ?? '—'}</span>
    }

    // Show in eMDR tables only if name + address present (street2 optional)
    const hasEmdrPrereqs = (r: Row) =>
        Boolean((r.provider_name ?? '').trim() && (r.provider_street ?? '').trim() && (r.provider_city ?? '').trim() && (r.provider_state ?? '').trim() && (r.provider_zip ?? '').trim())

    // Partition lists; all filtered by prereqs
    const notRegisteredRows = filteredRows.filter(r => !r.registered_for_emdr && hasEmdrPrereqs(r))
    const registeredRows = filteredRows.filter(r => r.registered_for_emdr && hasEmdrPrereqs(r))
    const electronicOnlyRows = filteredRows.filter(r => r.registered_for_emdr_electronic_only && hasEmdrPrereqs(r))

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

                        <div className="flex-1" />
                        <div className="w-72">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Filter by Customer (from table)</label>
                            <select
                                value={customerFilter}
                                onChange={e => setCustomerFilter(e.target.value as any)}
                                disabled={!hasRows}
                                className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-400"
                            >
                                <option value="all">All Customers</option>
                                <option value="unassigned">Unassigned</option>
                                {customerChoices.map(name => (
                                    <option key={name} value={name}>{name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    {!hasRows ? (
                        <p className="mt-3 text-sm text-gray-500">Click “Fetch from PCG” to load providers for this token.</p>
                    ) : (
                        <p className="mt-3 text-sm text-gray-500">
                            Showing {filteredRows.length} of {rows.length} NPIs
                            {customerFilter === 'all' ? '' : customerFilter === 'unassigned' ? ' • Unassigned' : ` • ${customerFilter}`}
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

                {/* ======================================== */}
                {/* Provider details & update table */}
                {/* ======================================== */}
                <div className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <h2 className="text-lg font-medium text-gray-900">Provider Details Updating</h2>
                        <p className="text-sm text-gray-500">
                            {hasRows ? (
                                <>
                                    Showing {filteredRows.length} NPIs • Filter:&nbsp;
                                    <span className="font-medium">{customerFilter === 'all' ? 'All Customers' : customerFilter === 'unassigned' ? 'Unassigned' : customerFilter}</span>
                                </>
                            ) : 'No data loaded'}
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
                            </tr>
                            </thead>
                            <tbody className="bg-white divide-y divide-gray-200">
                            {!hasRows || filteredRows.length === 0 ? (
                                <tr>
                                    {/* colSpan reduced to 16 (removed the old extra column) */}
                                    <td colSpan={16} className="px-6 py-8 text-center text-sm text-gray-500">
                                        {hasRows ? 'No rows match this filter.' : 'No data.'}
                                    </td>
                                </tr>
                            ) : (
                                filteredRows.map((r: Row) => {
                                    const actionJson = lastUpdatedNpi === r.providerNPI ? lastUpdateResponse : undefined
                                    const persistedJson = persistedMap.get(r.providerNPI)
                                    const jsonToShow = actionJson ?? persistedJson ?? null
                                    const regStatusClass =
                                        r.reg_status?.toLowerCase().includes('register') ? 'bg-green-100 text-green-800'
                                            : r.reg_status ? 'bg-amber-100 text-amber-800'
                                                : 'bg-gray-100 text-gray-800'

                                    return (
                                        <tr key={`${r.provider_id}-${r.providerNPI}`} className="hover:bg-gray-50 align-top">
                                            <td className="px-6 py-4 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                            <td className="px-6 py-4 text-sm">{r.last_submitted_transaction ? <Pill text={r.last_submitted_transaction} /> : <span className="text-gray-400">—</span>}</td>
                                            <td className="px-6 py-4"><Badge yes={Boolean(r.registered_for_emdr)} /></td>
                                            <td className="px-6 py-4"><Badge yes={Boolean(r.registered_for_emdr_electronic_only)} /></td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.customerName ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.providerGroupName ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700 break-words">{r.provider_street ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700 break-words">{r.provider_street2 ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_city ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_zip ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_state ?? '—'}</td>
                                            <td className="px-6 py-4">
                                                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${regStatusClass}`}>{r.reg_status ?? '—'}</span>
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.provider_id || '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700 align-top w-[40rem]"><JsonViewer data={r} /></td>
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
                                        </tr>
                                    )
                                })
                            )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* ====================================================== */}
                {/* eMDR Register/deRegister section (reordered)           */}
                {/* ====================================================== */}
                <div className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-3">
                        <div className="flex-1">
                            <h2 className="text-lg font-semibold text-gray-900">eMDR Register/deRegister</h2>
                            <p className="text-sm text-gray-500">Only NPIs with provider name and address are shown below. Update provider details first if needed.</p>
                        </div>

                        {/* NEW: bulk fetch registration details */}
                        <Form method="post">
                            <input type="hidden" name="intent" value="fetch-registrations" />
                            <button
                                type="submit"
                                className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                                disabled={!hasRows || isPending}
                                title="Fetch PCG registration status/details for all providers with a Provider ID"
                            >
                                <Icon name="refresh" className="h-4 w-4 mr-1.5" />
                                Fetch Registration Details
                            </button>
                        </Form>
                    </div>
                    {regFetchedAt ? (
                        <div className="px-6 pt-3 text-xs text-gray-500">
                            Last fetched registration details at <span className="font-medium">{new Date(regFetchedAt).toLocaleString()}</span>
                        </div>
                    ) : null}

                    {/* --- Table 1: Not registered for eMDR (moved to top) --- */}
                    <div className="px-6 py-5">
                        <h3 className="text-sm font-semibold text-gray-800 mb-3">Not registered for eMDR</h3>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">NPI</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reg Status</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stage</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Errors</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider ID</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action Response</th>
                                </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                {notRegisteredRows.length === 0 ? (
                                    <tr><td colSpan={8} className="px-6 py-6 text-sm text-gray-500 text-center">None</td></tr>
                                ) : (
                                    notRegisteredRows.map(r => {
                                        const reg = r.provider_id ? regById[r.provider_id] : undefined
                                        const anyError =
                                            (reg?.call_error_code || reg?.call_error_description) ||
                                            (reg?.errorList?.length ? reg.errorList.join('; ') : '') ||
                                            (reg?.errors?.length ? JSON.stringify(reg.errors) : '')
                                        return (
                                            <tr key={`unreg-${r.provider_id}-${r.providerNPI}`} className="align-top">
                                                <td className="px-6 py-3 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                                <td className="px-6 py-3"><RegStatusPill r={r} reg={reg} /></td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{reg?.stage ?? r.stage ?? '—'}</td>
                                                <td className="px-6 py-3 text-xs text-rose-700">{anyError ? <span className="inline-block max-w-xs break-words">{anyError}</span> : <span className="text-gray-400">—</span>}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_id || <span className="text-gray-400">—</span>}</td>
                                                <td className="px-6 py-3">
                                                    <ConfirmActionButton
                                                        intent="emdr-register"
                                                        providerId={r.provider_id}
                                                        providerNpi={r.providerNPI}
                                                        label="Register"
                                                        color="green"
                                                        disabled={isPending || !r.provider_id}
                                                        warning="Are you sure you want to register this NPI for eMDR? Electronic delivery will be enabled."
                                                    />
                                                    {!r.provider_id ? <p className="mt-2 text-xs text-amber-600">Provider ID missing — update provider details first.</p> : null}
                                                </td>
                                                <td className="px-6 py-3 text-sm text-gray-700 align-top w-[36rem]"><ActionResponseCell r={r} /></td>
                                            </tr>
                                        )
                                    })
                                )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <hr className="border-gray-200" />

                    {/* --- Table 2: Registered for eMDR --- */}
                    <div className="px-6 py-5">
                        <h3 className="text-sm font-semibold text-gray-800 mb-3">Registered for eMDR</h3>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">NPI</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Electronic Only?</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reg Status</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stage</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Change</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Txn IDs</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Errors</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider ID</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action Response</th>
                                </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                {registeredRows.length === 0 ? (
                                    <tr><td colSpan={11} className="px-6 py-6 text-sm text-gray-500 text-center">None</td></tr>
                                ) : (
                                    registeredRows.map(r => {
                                        const reg = r.provider_id ? regById[r.provider_id] : undefined
                                        const lastChange = reg?.status_changes?.length ? reg.status_changes[reg.status_changes.length - 1] : undefined
                                        const txnDisplay =
                                            typeof reg?.transaction_id_list === 'string'
                                                ? reg.transaction_id_list.replace(/,+$/, '')
                                                : (lastChange?.esmd_transaction_id ?? '')
                                        const anyError =
                                            (reg?.call_error_code || reg?.call_error_description) ||
                                            (reg?.errorList?.length ? reg.errorList.join('; ') : '') ||
                                            (reg?.errors?.length ? JSON.stringify(reg.errors) : '')
                                        return (
                                            <tr key={`reg-${r.provider_id}-${r.providerNPI}`} className="align-top">
                                                <td className="px-6 py-3 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                                <td className="px-6 py-3"><Badge yes={Boolean(r.registered_for_emdr_electronic_only)} /></td>
                                                <td className="px-6 py-3"><RegStatusPill r={r} reg={reg} /></td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{reg?.stage ?? r.stage ?? '—'}</td>
                                                <td className="px-6 py-3 text-xs text-gray-700">
                                                    {lastChange ? (
                                                        <div className="space-y-0.5">
                                                            <div><span className="font-medium">Time:</span> {lastChange.time}</div>
                                                            <div><span className="font-medium">Title:</span> {lastChange.title}</div>
                                                            <div><span className="font-medium">Status:</span> {lastChange.status}</div>
                                                        </div>
                                                    ) : <span className="text-gray-400">—</span>}
                                                </td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{txnDisplay ? <Pill text={txnDisplay} /> : <span className="text-gray-400">—</span>}</td>
                                                <td className="px-6 py-3 text-xs text-rose-700">{anyError ? <span className="inline-block max-w-xs break-words">{anyError}</span> : <span className="text-gray-400">—</span>}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_id || '—'}</td>
                                                <td className="px-6 py-3">
                                                    <div className="flex gap-2 flex-col">
                                                        <ConfirmActionButton
                                                            intent="emdr-deregister"
                                                            providerId={r.provider_id}
                                                            providerNpi={r.providerNPI}
                                                            label="Deregister"
                                                            color="rose"
                                                            disabled={isPending || !r.provider_id}
                                                            warning="Are you sure you want to deregister this NPI from eMDR? Electronic delivery will stop."
                                                        />
                                                        {!r.registered_for_emdr_electronic_only ? (
                                                            <ConfirmActionButton
                                                                intent="emdr-electronic-only"
                                                                providerId={r.provider_id}
                                                                providerNpi={r.providerNPI}
                                                                label="Set Electronic Only"
                                                                color="purple"
                                                                disabled={isPending || !r.provider_id}
                                                                warning="Are you sure you want to set Electronic-Only ADR for this NPI? Paper mail will stop."
                                                            />
                                                        ) : null}
                                                    </div>
                                                </td>
                                                <td className="px-6 py-3 text-sm text-gray-700 align-top w-[36rem]"><ActionResponseCell r={r} /></td>
                                            </tr>
                                        )
                                    })
                                )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    <hr className="border-gray-200" />

                    {/* --- Table 3: Registered for Electronic-Only ADR --- */}
                    <div className="px-6 py-5">
                        <h3 className="text-sm font-semibold text-gray-800 mb-3">Registered for Electronic-Only ADR</h3>
                        <p className="text-xs text-gray-500 mb-2">To revert to standard delivery (mail + electronic), deregister and then register again.</p>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y divide-gray-200">
                                <thead className="bg-gray-50">
                                <tr>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">NPI</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Reg Status</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Stage</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Errors</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider ID</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Actions</th>
                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Action Response</th>
                                </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                {electronicOnlyRows.length === 0 ? (
                                    <tr><td colSpan={8} className="px-6 py-6 text-sm text-gray-500 text-center">None</td></tr>
                                ) : (
                                    electronicOnlyRows.map(r => {
                                        const reg = r.provider_id ? regById[r.provider_id] : undefined
                                        const anyError =
                                            (reg?.call_error_code || reg?.call_error_description) ||
                                            (reg?.errorList?.length ? reg.errorList.join('; ') : '') ||
                                            (reg?.errors?.length ? JSON.stringify(reg.errors) : '')
                                        return (
                                            <tr key={`eo-${r.provider_id}-${r.providerNPI}`} className="align-top">
                                                <td className="px-6 py-3 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                                <td className="px-6 py-3"><RegStatusPill r={r} reg={reg} /></td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{reg?.stage ?? r.stage ?? '—'}</td>
                                                <td className="px-6 py-3 text-xs text-rose-700">{anyError ? <span className="inline-block max-w-xs break-words">{anyError}</span> : <span className="text-gray-400">—</span>}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_id || '—'}</td>
                                                <td className="px-6 py-3">
                                                    <ConfirmActionButton
                                                        intent="emdr-deregister"
                                                        providerId={r.provider_id}
                                                        providerNpi={r.providerNPI}
                                                        label="Deregister"
                                                        color="rose"
                                                        disabled={isPending || !r.provider_id}
                                                        warning="Are you sure you want to deregister this NPI from eMDR? This will also remove Electronic-Only ADR."
                                                    />
                                                </td>
                                                <td className="px-6 py-3 text-sm text-gray-700 align-top w-[36rem]"><ActionResponseCell r={r} /></td>
                                            </tr>
                                        )
                                    })
                                )}
                                </tbody>
                            </table>
                        </div>
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
                                <input name="provider_city" defaultValue={drawer.seed?.provider_city ?? ''} required className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700">State</label>
                                <input name="provider_state" defaultValue={drawer.seed?.provider_state ?? ''} required maxLength={2} className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm uppercase" placeholder="MD" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700">ZIP</label>
                                <input name="provider_zip" defaultValue={drawer.seed?.provider_zip ?? ''} required className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm" placeholder="12345" />
                            </div>
                        </div>

                        <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                            <button type="button" onClick={closeDrawer} className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
                            <button type="submit" disabled={isPending} className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">Submit</button>
                        </div>
                    </Form>
                ) : null}
            </Drawer>
        </InterexLayout>
    )
}
