// app/routes/providers-emdr.tsx
import * as React from 'react'
import { createPortal } from 'react-dom'
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
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { audit } from '#app/services/audit.server.ts'
import {
    pcgGetProviders,
    pcgUpdateProvider,
    pcgSetEmdrRegistration,
    pcgSetElectronicOnly,
    pcgGetProviderRegistration,
    type PcgProviderListItem,
    type PcgUpdateProviderPayload,
} from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'

type Row = PcgProviderListItem & {
    customerName: string | null
    provider_name: string | null
    providerGroupName: string | null
    assignedToUsernames?: string[]
    assignedToEmails?: string[]
}

type StoredUpdate = { npi: string; response: unknown | null }
type RegResp = Awaited<ReturnType<typeof pcgGetProviderRegistration>>

/* ------------------------ Helpers (server) ------------------------ */

function roleLabelFrom(roles: string[]) {
    if (roles.includes(INTEREX_ROLES.CUSTOMER_ADMIN)) return 'Customer Admin'
    if (roles.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)) return 'Provider Group Admin'
    if (roles.includes(INTEREX_ROLES.SYSTEM_ADMIN)) return 'System Admin'
    return 'Basic User'
}

/** Coerce a maybe-array/maybe-string value into a CSV string (or null). */
function toCsv(v: unknown): string | null {
    if (Array.isArray(v)) {
        return (v as unknown[]).map(x => String(x)).join(',')
    }
    return typeof v === 'string' ? v : null
}

/** Convert a remote list item into the normalized list-detail shape our mapper expects. */
function mapListItemToDetail(r: PcgProviderListItem) {
    return {
        providerNpi: r.providerNPI,
        pcgProviderId: (r as any).provider_id ?? null,
        lastSubmittedTransaction: r.last_submitted_transaction ?? null,
        registeredForEmdr: Boolean(r.registered_for_emdr),
        registeredForEmdrElectronicOnly: Boolean(r.registered_for_emdr_electronic_only),
        stage: r.stage ?? null,
        regStatus: r.reg_status ?? null,
        status: r.status ?? null,
        esMDTransactionID: r.esMDTransactionID ?? null,
        providerName: r.provider_name ?? null,
        providerStreet: r.provider_street ?? null,
        providerStreet2: r.provider_street2 ?? null,
        providerCity: r.provider_city ?? null,
        providerState: r.provider_state ?? null,
        providerZip: r.provider_zip ?? null,
        transactionIdList: toCsv(r.transaction_id_list),
        notificationDetails: r.notificationDetails ?? [],
        statusChanges: r.status_changes ?? [],
        errors: r.errors ?? [],
        errorList: r.errorList ?? [],
    }
}

/** Persist a single registration payload into ProviderRegistrationStatus. */
async function upsertRegistrationStatus(opts: { providerId: string; reg: RegResp }) {
    const { providerId, reg } = opts
    const base = {
        fetchedAt: new Date(),
        providerNpi: reg.providerNPI,
        pcgProviderId: reg.provider_id,
        regStatus: reg.reg_status ?? null,
        stage: reg.stage ?? null,
        submissionStatus: reg.submission_status ?? null,
        status: reg.status ?? null,
        callErrorCode: reg.call_error_code ?? null,
        callErrorDescription: reg.call_error_description ?? null,
        providerName: reg.provider_name ?? null,
        providerStreet: reg.provider_street ?? null,
        providerStreet2: reg.provider_street2 ?? null,
        providerCity: reg.provider_city ?? null,
        providerState: reg.provider_state ?? null,
        providerZip: reg.provider_zip ?? null,
        transactionIdList: toCsv(reg.transaction_id_list),
        statusChanges: (reg.status_changes ?? []) as any,
        errors: (reg.errors ?? []) as any,
        errorList: (reg.errorList ?? []) as any,
    }

    await prisma.providerRegistrationStatus.upsert({
        where: { providerId },
        create: { providerId, ...base },
        update: base,
    })
}

/** Build provider update from remote item for the legacy Provider columns */
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

function writeAdminAudit(request: Request, user: { id: string; name?: string | null; customerId?: string | null; roles: { name: string }[] }, opts: {
    action: string
    success: boolean
    message?: string | null
    entityType?: string | null
    entityId?: string | null
    meta?: unknown
}) {
    const route = new URL(request.url).pathname
    return audit.admin({
        action: opts.action,
        actorType: 'USER',
        actorId: user.id,
        actorDisplay: user.name || null,
        customerId: user.customerId || null,
        status: opts.success ? 'SUCCESS' : 'FAILURE',
        entityType: opts.entityType || null,
        entityId: opts.entityId || null,
        summary: opts.message || null,
        metadata: {
            route,
            roles: user.roles.map(r => r.name),
            legacyMeta: opts.meta ?? undefined,
        },
    })
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

/** Convert persisted records into the UI Row shape */
function mapPersistedToRow(p: {
    npi: string
    name: string | null
    pcgProviderId: string | null
    providerStreet: string | null
    providerStreet2: string | null
    providerCity: string | null
    providerState: string | null
    providerZip: string | null
    customerName: string | null
    providerGroupName: string | null
    usernames?: (string | null)[]
    emails?: (string | null)[]
    listDetail: {
        providerNpi: string
        pcgProviderId: string | null
        lastSubmittedTransaction: string | null
        registeredForEmdr: boolean
        registeredForEmdrElectronicOnly: boolean
        stage: string | null
        regStatus: string | null
        status: string | null
        esMDTransactionID: string | null
        providerName: string | null
        providerStreet: string | null
        providerStreet2: string | null
        providerCity: string | null
        providerState: string | null
        providerZip: string | null
        transactionIdList: string | null
        notificationDetails: any | null
        statusChanges: any | null
        errors: any | null
        errorList: any | null
    } | null
    registrationStatus: {
        providerNpi: string
        pcgProviderId: string
        regStatus: string | null
        stage: string | null
        submissionStatus: string | null
        status: string | null
        transactionIdList: string | null
        statusChanges: any | null
        errors: any | null
        errorList: any | null
    } | null
}): Row {
    const ld = p.listDetail
    const rs = p.registrationStatus
    const provider_id = rs?.pcgProviderId ?? ld?.pcgProviderId ?? p.pcgProviderId ?? ''

    const r: Row = {
        errorList: ((rs?.errorList as any) ?? (ld?.errorList as any) ?? []) as any[],
        providerNPI: p.npi,
        last_submitted_transaction: ld?.lastSubmittedTransaction ?? null,
        status_changes: ((rs?.statusChanges as any) ?? (ld?.statusChanges as any) ?? []) as any[],
        registered_for_emdr: Boolean(ld?.registeredForEmdr),
        provider_street: ld?.providerStreet ?? p.providerStreet,
        registered_for_emdr_electronic_only: Boolean(ld?.registeredForEmdrElectronicOnly),
        provider_state: ld?.providerState ?? p.providerState,
        stage: rs?.stage ?? ld?.stage ?? null,
        notificationDetails: (ld?.notificationDetails as any) ?? [],
        transaction_id_list:
            rs?.transactionIdList
                ? rs.transactionIdList.split(',').filter(Boolean)
                : ld?.transactionIdList
                    ? ld.transactionIdList.split(',').filter(Boolean)
                    : null,
        reg_status: rs?.regStatus ?? ld?.regStatus ?? null,
        provider_id,
        provider_city: ld?.providerCity ?? p.providerCity,
        provider_zip: ld?.providerZip ?? p.providerZip,
        provider_name: ld?.providerName ?? p.name ?? null,
        submission_status: rs?.submissionStatus ?? null,
        errors: ((rs?.errors as any) ?? (ld?.errors as any) ?? []) as any[],
        provider_street2: ld?.providerStreet2 ?? p.providerStreet2,
        esMDTransactionID: ld?.esMDTransactionID ?? null,
        status: rs?.status ?? ld?.status ?? null,

        customerName: p.customerName,
        providerGroupName: p.providerGroupName,

        assignedToUsernames: (p.usernames ?? []).filter(Boolean) as string[],
        assignedToEmails: (p.emails ?? []).filter(Boolean) as string[],
    }

    return r
}

/** Build the visibility scope (Provider.where) for the given userId */
async function buildScopeWhere(userId: string) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            customerId: true,
            providerGroupId: true,
            roles: { select: { name: true } },
        },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })
    const roleNames = user.roles.map(r => r.name)

    if (roleNames.includes(INTEREX_ROLES.SYSTEM_ADMIN)) {
        return { where: {}, roleNames }
    }

    if (roleNames.includes(INTEREX_ROLES.CUSTOMER_ADMIN)) {
        return { where: { customerId: user.customerId ?? undefined }, roleNames }
    }

    if (roleNames.includes(INTEREX_ROLES.PROVIDER_GROUP_ADMIN)) {
        let groupIds: string[] = []
        if (user.providerGroupId) groupIds.push(user.providerGroupId)
        try {
            const memberships = await (prisma as any).providerGroupMember.findMany({
                where: { userId: user.id },
                select: { providerGroupId: true },
            })
            groupIds.push(...(memberships || []).map((m: any) => m.providerGroupId))
        } catch {}
        groupIds = Array.from(new Set(groupIds)).filter(Boolean) as string[]
        return { where: groupIds.length ? { providerGroupId: { in: groupIds } } : { id: { in: [] as string[] } }, roleNames }
    }

    return {
        where: {
            customerId: user.customerId ?? undefined,
            userNpis: { some: { userId: user.id } },
        },
        roleNames,
    }
}

/** Compose rows limited by a Prisma where filter */
async function composeRows(where: any) {
    const providers = await prisma.provider.findMany({
        where,
        select: {
            id: true,
            npi: true,
            name: true,
            pcgProviderId: true,
            providerStreet: true,
            providerStreet2: true,
            providerCity: true,
            providerState: true,
            providerZip: true,
            pcgUpdateResponse: true,
            pcgListSnapshot: true,
            customerId: true,
            providerGroupId: true,
            registrationStatus: {
                select: {
                    providerNpi: true,
                    pcgProviderId: true,
                    regStatus: true,
                    stage: true,
                    submissionStatus: true,
                    status: true,
                    transactionIdList: true,
                    statusChanges: true,
                    errors: true,
                    errorList: true,
                },
            },
            userNpis: { select: { user: { select: { username: true, email: true } } } },
        },
        orderBy: [{ npi: 'asc' }],
    })

    const customerIds = Array.from(new Set(providers.map(p => p.customerId).filter(Boolean))) as string[]
    const groupIds = Array.from(new Set(providers.map(p => p.providerGroupId).filter(Boolean))) as string[]

    const [customers, groups] = await Promise.all([
        customerIds.length
            ? prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, name: true } })
            : Promise.resolve([]),
        groupIds.length
            ? prisma.providerGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, name: true } })
            : Promise.resolve([]),
    ])

    const customerNameById = new Map(customers.map(c => [c.id, c.name] as const))
    const groupNameById = new Map(groups.map(g => [g.id, g.name] as const))

    const rows: Row[] = providers.map(p => {
        const snapshot = (p.pcgListSnapshot as any) as PcgProviderListItem | null
        const listDetail = snapshot ? mapListItemToDetail(snapshot) : null

        const usernames = (p.userNpis ?? [])
            .map(u => (u as any).user?.username ?? null)
            .filter(Boolean) as string[]
        const emails = (p.userNpis ?? [])
            .map(u => (u as any).user?.email ?? null)
            .filter(Boolean) as string[]

        return mapPersistedToRow({
            npi: p.npi,
            name: p.name ?? null,
            pcgProviderId: p.pcgProviderId ?? null,
            providerStreet: p.providerStreet ?? null,
            providerStreet2: p.providerStreet2 ?? null,
            providerCity: p.providerCity ?? null,
            providerState: p.providerState ?? null,
            providerZip: p.providerZip ?? null,
            customerName: p.customerId ? customerNameById.get(p.customerId) ?? null : null,
            providerGroupName: p.providerGroupId ? groupNameById.get(p.providerGroupId) ?? null : null,
            listDetail,
            registrationStatus: p.registrationStatus ? (p.registrationStatus as any) : null,
            usernames,
            emails,
        })
    })

    const storedUpdates: StoredUpdate[] = providers.map(p => ({
        npi: p.npi,
        response: p.pcgUpdateResponse ?? null,
    }))

    return { rows, storedUpdates }
}

/* ----------------------------- Loader ----------------------------- */
export async function loader({ request }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const { where, roleNames } = await buildScopeWhere(userId)

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, roles: { select: { name: true } } },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    const { rows, storedUpdates } = await composeRows(where)

    return data({
        user,
        roleLabel: roleLabelFrom(roleNames),
        baseRows: rows,
        updateResponses: storedUpdates,
    })
}

/* ----------------------------- Action ----------------------------- */
export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const { where, roleNames } = await buildScopeWhere(userId)

    const form = await request.formData()
    const intent = String(form.get('intent') || '')

    if (intent === 'fetch') {
        let pcgError: string | null = null
        try {
            const remote = await getAllProvidersFromPCG()

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
                Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, (i + 1) * i + size))

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
        const fullUserFetch = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, roles: { select: { name: true } }, customerId: true },
        })
        if (fullUserFetch) {
            await writeAdminAudit(request, fullUserFetch, {
                action: 'PCG_FETCH',
                entityType: 'PROVIDER',
                success: !pcgError,
                message: pcgError ?? 'Fetched providers from PCG',
                meta: { error: pcgError || undefined },
            })
        }

        const { rows, storedUpdates } = await composeRows(where)
        return data({
            rows,
            meta: { totalForScope: rows.length },
            pcgError,
            didUpdate: false as const,
            updatedNpi: undefined,
            updateResponse: undefined,
            updateResponses: storedUpdates,
            roleLabel: roleLabelFrom(roleNames),
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

            try {
                const remote = await getAllProvidersFromPCG()
                const match = remote.find(r => r.providerNPI === payload.provider_npi)
                if (match) {
                    await prisma.provider.update({
                        where: { npi: payload.provider_npi },
                        data: { pcgListSnapshot: match as any, pcgListAt: new Date() },
                    })
                }
            } catch {}
        } catch (err: any) {
            pcgError = err?.message || 'Failed to update provider.'
        }
        const fullUserUpd = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, roles: { select: { name: true } }, customerId: true },
        })
        if (fullUserUpd) {
            await writeAdminAudit(request, fullUserUpd, {
                action: 'PROVIDER_UPDATE',
                entityType: 'PROVIDER',
                entityId: payload.provider_npi,
                success: !pcgError,
                message: pcgError ?? `Updated provider ${payload.provider_npi}`,
                meta: { error: pcgError || undefined, payload, updateResponse },
            })
        }

        const { rows, storedUpdates } = await composeRows(where)
        return data({
            rows,
            meta: { totalForScope: rows.length },
            pcgError,
            didUpdate,
            updatedNpi: payload.provider_npi,
            updateResponse,
            updateResponses: storedUpdates,
            roleLabel: roleLabelFrom(roleNames),
        })
    }

    if (intent === 'fetch-registrations') {
        const now = new Date()
        const nowIso = now.toISOString()

        const candidates = await prisma.provider.findMany({
            where: {
                ...where,
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
                id: true,
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
                    await upsertRegistrationStatus({ providerId: c.id, reg: data })
                } catch (err: any) {
                    const fallback = {
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
                    } as any as RegResp

                    regById[c.pcgProviderId!] = fallback
                    await upsertRegistrationStatus({ providerId: c.id, reg: fallback })
                }
            }
        }

        const { rows, storedUpdates } = await composeRows(where)
        const fullUserReg = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, roles: { select: { name: true } }, customerId: true },
        })
        if (fullUserReg) {
            await writeAdminAudit(request, fullUserReg, {
                action: 'REG_FETCH',
                entityType: 'PROVIDER',
                success: true,
                message: `Fetched registration details for ${Object.keys(regById).length} providers`,
                meta: { count: Object.keys(regById).length },
            })
        }

        return data({
            rows,
            meta: { totalForScope: rows.length },
            pcgError: null,
            didUpdate: false as const,
            updatedNpi: undefined,
            updateResponse: undefined,
            updateResponses: storedUpdates,
            regById,
            regFetchedAt: nowIso,
            roleLabel: roleLabelFrom(roleNames),
        })
    }

    if (intent === 'emdr-register' || intent === 'emdr-deregister' || intent === 'emdr-electronic-only') {
        const providerId = String(form.get('provider_id') || '').trim()
        const providerNpi = String(form.get('provider_npi') || '').trim()
        if (!providerId) {
            return data({ error: 'Missing provider_id. Update Provider first to obtain a Provider ID.' }, { status: 400 })
        }

        let pcgError: string | null = null
        let updateResponse: any = null

        const regById: Record<string, RegResp> = Object.create(null)
        const now = new Date()
        const nowIso = now.toISOString()

        try {
            if (intent === 'emdr-register') updateResponse = await pcgSetEmdrRegistration(providerId, true)
            else if (intent === 'emdr-deregister') updateResponse = await pcgSetEmdrRegistration(providerId, false)
            else updateResponse = await pcgSetElectronicOnly(providerId)

            const existing = await prisma.provider.findUnique({
                where: { npi: providerNpi },
                select: { id: true, pcgProviderId: true, npi: true },
            })
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

            try {
                const reg = await pcgGetProviderRegistration(providerId)
                regById[providerId] = reg
                if (existing) {
                    await upsertRegistrationStatus({ providerId: existing.id, reg })
                }
            } catch {}
        } catch (err: any) {
            pcgError = err?.message || 'Failed to submit eMDR registration/deregistration.'
        }

        try {
            const remote = await getAllProvidersFromPCG()
            const match = remote.find(r => r.providerNPI === providerNpi)
            if (match) {
                await prisma.provider.update({
                    where: { npi: providerNpi },
                    data: { pcgListSnapshot: match as any, pcgListAt: now },
                })
            }
        } catch {}

        const { rows, storedUpdates } = await composeRows(where)

        const result = data({
            rows,
            meta: { totalForScope: rows.length },
            pcgError,
            didUpdate: false as const,
            updatedNpi: providerNpi,
            updateResponse,
            updateResponses: storedUpdates,
            regById,
            regFetchedAt: nowIso,
            lastAction: {
                kind: intent as 'emdr-register' | 'emdr-deregister' | 'emdr-electronic-only',
                npi: providerNpi,
                providerId,
                ok: !pcgError,
                at: nowIso,
            },
            roleLabel: roleLabelFrom(roleNames),
        })
        const fullUserEmdr = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, roles: { select: { name: true } }, customerId: true },
        })
        if (fullUserEmdr) {
            await writeAdminAudit(request, fullUserEmdr, {
                action:
                    intent === 'emdr-register'
                        ? 'EMDR_REGISTER'
                        : intent === 'emdr-deregister'
                            ? 'EMDR_DEREGISTER'
                            : 'EMDR_ELECTRONIC_ONLY',
                entityType: 'PROVIDER',
                entityId: providerNpi,
                success: !pcgError,
                message: pcgError ?? `eMDR action ${intent} for NPI ${providerNpi}`,
                meta: { providerId, providerNpi, error: pcgError || undefined },
            })
        }
        return result
    }

    return data({ error: 'Invalid action' }, { status: 400 })
}

/* ------------------------- Client-side types ------------------------- */
type LastActionSignal = {
    kind: 'emdr-register' | 'emdr-deregister' | 'emdr-electronic-only'
    npi: string
    providerId: string
    ok: boolean
    at: string
}

type StatusChange = {
    split_number?: string
    time?: string
    title?: string
    esmd_transaction_id?: string | null
    status?: string
    [k: string]: any
}

type ActionSuccess = {
    user: any
    roleLabel: string
    rows: Row[]
    meta: { totalForScope: number }
    pcgError: string | null
    didUpdate?: boolean
    updatedNpi?: string
    updateResponse?: any
    updateResponses?: { npi: string; response: unknown | null }[]

    regById?: Record<string, RegResp>
    regFetchedAt?: string

    lastAction?: LastActionSignal
}
type ActionFailure = { error: string }
type ActionData = ActionSuccess | ActionFailure

function Badge({ yes }: { yes: boolean }) {
    const cls = yes
        ? 'bg-green-100 text-green-800 ring-1 ring-green-300'
        : 'bg-gray-100 text-gray-800 ring-1 ring-gray-300'
    return (
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {yes ? 'Yes' : 'No'}
    </span>
    )
}
function Pill({ text }: { text: string }) {
    return (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 ring-1 ring-blue-200">
      {text}
    </span>
    )
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
                                 resetOn,
                             }: {
    intent: 'emdr-register' | 'emdr-deregister' | 'emdr-electronic-only'
    providerId?: string
    providerNpi: string
    label: string
    color?: 'blue' | 'green' | 'rose' | 'purple'
    disabled?: boolean
    warning: string
    resetOn?: string | undefined
}) {
    const [open, setOpen] = React.useState(false)
    const [checked, setChecked] = React.useState(false)

    React.useEffect(() => {
        if (resetOn) {
            setOpen(false)
            setChecked(false)
        }
    }, [resetOn])

    // unified, accessible color styles (fixed colors)
    const colorBase =
        color === 'green'
            ? 'bg-emerald-600 hover:bg-emerald-700 focus-visible:ring-emerald-500'
            : color === 'rose'
                ? 'bg-rose-600 hover:bg-rose-700 focus-visible:ring-rose-500'
                : color === 'purple'
                    ? 'bg-violet-600 hover:bg-violet-700 focus-visible:ring-violet-500'
                    : 'bg-blue-600 hover:bg-blue-700 focus-visible:ring-blue-500'

    const colorClass = `${colorBase} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2`

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
                <Icon name="question-mark-circled" className="h-4 w-4 text-amber-600 mt-0.5" />
                <div>{warning}</div>
            </div>
            <label className="flex items-center">
                <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-gray-300 text-blue-600"
                    checked={checked}
                    onChange={e => setChecked(e.target.checked)}
                />
                <span className="ml-2 text-xs text-gray-700">I understand and want to proceed.</span>
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

/* ----------------------- Sticky JSON Popover ----------------------- */
function StickyJsonPopover({
                               open,
                               anchorEl,
                               title,
                               data,
                               onClose,
                           }: {
    open: boolean
    anchorEl: HTMLElement | null | undefined
    title?: string
    data?: any
    onClose: () => void
}) {
    const panelRef = React.useRef<HTMLDivElement | null>(null)
    const [pos, setPos] = React.useState<{ top: number; left: number }>({ top: 0, left: 0 })
    const [placement, setPlacement] = React.useState<{ side: 'left' | 'right'; align: 'top' | 'bottom'; arrowTop: number }>({
        side: 'right',
        align: 'top',
        arrowTop: 16,
    })
    const jsonText = React.useMemo(() => JSON.stringify(data ?? {}, null, 2), [data])

    const recompute = React.useCallback(() => {
        if (!anchorEl || typeof window === 'undefined') return
        const rect = anchorEl.getBoundingClientRect()
        const preferredWidth = panelRef.current?.offsetWidth || 480
        const preferredHeight = panelRef.current?.offsetHeight || 320
        const gap = 8

        let side: 'left' | 'right' = 'right'
        let left = rect.right + gap
        if (left + preferredWidth > window.innerWidth - gap) {
            side = 'left'
            left = Math.max(gap, rect.left - preferredWidth - gap)
        }

        let align: 'top' | 'bottom' = 'top'
        let top = rect.top
        if (top + preferredHeight > window.innerHeight - gap) {
            align = 'bottom'
            top = Math.max(gap, rect.bottom - preferredHeight)
        }

        top = Math.min(Math.max(gap, top), Math.max(gap, window.innerHeight - preferredHeight - gap))
        left = Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - preferredWidth - gap))

        const anchorCenterY = rect.top + rect.height / 2
        const arrowTop = Math.min(preferredHeight - 16, Math.max(16, anchorCenterY - top))

        setPos({ top, left })
        setPlacement({ side, align, arrowTop })
    }, [anchorEl])

    const scrollParentsRef = React.useRef<HTMLElement[]>([])

    React.useEffect(() => {
        if (!open) return
        recompute()
        const raf = requestAnimationFrame(() => recompute())

        const handler = () => recompute()

        const scrollParents: HTMLElement[] = []
        if (anchorEl && typeof window !== 'undefined') {
            let node: HTMLElement | null = anchorEl
            const isScrollable = (el: HTMLElement) => {
                const style = window.getComputedStyle(el)
                const overflow = `${style.overflow}${style.overflowX}${style.overflowY}`
                return /(auto|scroll|overlay)/.test(overflow)
            }
            while (node) {
                if (isScrollable(node)) scrollParents.push(node)
                node = node.parentElement
            }
        }

        scrollParents.forEach(p => p.addEventListener('scroll', handler, { passive: true }))
        if (typeof window !== 'undefined') {
            window.addEventListener('scroll', handler, { passive: true })
            window.addEventListener('resize', handler)
        }

        let ro: ResizeObserver | null = null
        if (typeof window !== 'undefined' && 'ResizeObserver' in window) {
            ro = new ResizeObserver(() => handler())
            if (anchorEl) ro.observe(anchorEl)
            if (panelRef.current) ro.observe(panelRef.current)
        }

        scrollParentsRef.current = scrollParents

        return () => {
            cancelAnimationFrame(raf)
            scrollParents.forEach(p => p.removeEventListener('scroll', handler))
            if (typeof window !== 'undefined') {
                window.removeEventListener('scroll', handler)
                window.removeEventListener('resize', handler)
            }
            if (ro) ro.disconnect()
        }
    }, [open, anchorEl, recompute])

    React.useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        }
        const onClick = (e: MouseEvent) => {
            const target = e.target as Node | null
            if (!panelRef.current) return
            const clickedInsidePanel = panelRef.current.contains(target)
            const clickedAnchor = anchorEl ? anchorEl.contains(target) : false
            if (!clickedInsidePanel && !clickedAnchor) onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onClick, true)
        return () => {
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('mousedown', onClick, true)
        }
    }, [open, onClose, anchorEl])

    React.useEffect(() => {
        if (!open || !anchorEl) return
        anchorEl.classList.add('ring-2', 'ring-offset-2', 'ring-red-300', 'rounded')
        return () => {
            anchorEl.classList.remove('ring-2', 'ring-offset-2', 'ring-red-300', 'rounded')
        }
    }, [open, anchorEl])

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(jsonText)
        } catch {}
    }

    if (!open || typeof document === 'undefined') return null

    return createPortal(
        <div className="fixed inset-0 z-[1000] pointer-events-none">
            <div
                ref={panelRef}
                style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
                className="pointer-events-auto fixed w-[480px] max-w-[90vw] max-h-[80vh] rounded-lg border border-gray-200 bg-white shadow-xl"
            >
                <div
                    aria-hidden
                    style={{
                        top: placement.arrowTop,
                        [placement.side === 'right' ? 'left' : 'right']: '-6px',
                    } as React.CSSProperties}
                    className="absolute"
                >
                    <div className="w-3 h-3 rotate-45 bg-white border-t border-l border-gray-200 shadow-sm" />
                </div>

                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200">
                    <div className="flex items-center gap-2">
                        <Icon name="question-mark-circled" className="h-4 w-4 text-red-600" />
                        <h4 className="text-sm font-semibold text-gray-900">{title || 'Error Details'}</h4>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={copy}
                            className="inline-flex items-center rounded-md bg-gray-800 px-2.5 py-1 text-xs font-semibold text-white hover:bg-gray-700"
                            title="Copy JSON to clipboard"
                        >
                            <Icon name="file-text" className="h-3.5 w-3.5 mr-1" />
                            Copy JSON
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            title="Close"
                        >
                            <Icon name="cross-1" className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
                <div className="p-3">
                    <div className="rounded-md border border-gray-200 bg-gray-50">
            <pre className="m-0 p-3 text-xs leading-5 text-gray-900 whitespace-pre overflow-auto max-h-[60vh]">
{jsonText}
            </pre>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    )
}

/* ------------------------------ Component ------------------------------ */
export default function ProvidersEmdrScopedPage() {
    const { user, roleLabel, baseRows, updateResponses } = useLoaderData<{
        user: any
        roleLabel: string
        baseRows: Row[]
        updateResponses: StoredUpdate[]
    }>()
    const actionData = useActionData<ActionData>()
    const isPending = useIsPending()

    const hasRows = Boolean(actionData && 'rows' in actionData)
    const rows: Row[] = hasRows ? (actionData as ActionSuccess).rows : baseRows
    const pcgError = hasRows ? (actionData as ActionSuccess).pcgError : null
    const uiRoleLabel = hasRows ? (actionData as ActionSuccess).roleLabel : roleLabel

    const lastUpdatedNpi = hasRows ? (actionData as ActionSuccess).updatedNpi : undefined
    const lastUpdateResponse = hasRows ? (actionData as ActionSuccess).updateResponse : undefined
    const persistedMap = React.useMemo(() => {
        const m = new Map<string, unknown | null>()
        ;(hasRows ? (actionData as ActionSuccess).updateResponses ?? updateResponses : updateResponses).forEach(u =>
            m.set(u.npi, u.response),
        )
        return m
    }, [hasRows, actionData, updateResponses])

    const lastAction = hasRows ? (actionData as ActionSuccess).lastAction : undefined

    const regById = (hasRows ? (actionData as ActionSuccess).regById : undefined) || {}
    const regFetchedAt = hasRows ? (actionData as ActionSuccess).regFetchedAt : undefined

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

    // Removed unused ActionResponseCell (legacy debugging component)

    function RegStatusPill({ r, reg }: { r: Row; reg?: RegResp }) {
        const val = reg?.reg_status ?? r.reg_status
        const cls =
            val?.toLowerCase().includes('register')
                ? 'bg-green-100 text-green-800'
                : val
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-gray-100 text-gray-800'
        return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>{val ?? '—'}</span>
    }

    const [errorPopover, setErrorPopover] = React.useState<{ open: boolean; title?: string; data?: any; anchorEl?: HTMLElement | null }>({ open: false })

    function buildErrorPayload(r: Row, reg?: RegResp) {
        const payload = {
            providerNPI: r.providerNPI,
            provider_id: r.provider_id || null,
            reg_status: reg?.reg_status ?? r.reg_status ?? null,
            stage: reg?.stage ?? r.stage ?? null,
            call_error_code: reg?.call_error_code ?? null,
            call_error_description: reg?.call_error_description ?? null,
            errorList: (reg?.errorList && reg.errorList.length ? reg.errorList : r.errorList) ?? [],
            errors: (reg?.errors && (reg.errors as any[]).length ? reg.errors : r.errors) ?? [],
        }
        const has =
            Boolean(payload.call_error_code) ||
            Boolean(payload.call_error_description) ||
            (Array.isArray(payload.errorList) && payload.errorList.length > 0) ||
            (Array.isArray(payload.errors) && payload.errors.length > 0)
        return { has, payload }
    }

    const hasEmdrPrereqs = (r: Row) =>
        Boolean(
            (r.provider_name ?? '').trim() &&
            (r.provider_street ?? '').trim() &&
            (r.provider_city ?? '').trim() &&
            (r.provider_state ?? '').trim() &&
            (r.provider_zip ?? '').trim(),
        )

    const notRegisteredRows = rows.filter(r => !r.registered_for_emdr && hasEmdrPrereqs(r))
    const registeredRows = rows.filter(r => r.registered_for_emdr && hasEmdrPrereqs(r))
    const electronicOnlyRows = rows.filter(r => r.registered_for_emdr_electronic_only && hasEmdrPrereqs(r))

    return (
        <InterexLayout
            user={user}
            title="Providers & eMDR"
            subtitle={`${uiRoleLabel} • Scoped to your access`}
            showBackButton
            backTo="/dashboard"
            currentPath="/providers-emdr"
        >
            <LoadingOverlay show={Boolean(isPending)} title="Loading…" message="Please don't refresh or close this tab." />

            <div className="max-w-11/12 mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
                {/* Refresh section */}
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
                        <p className="text-sm text-gray-500">Showing {rows.length} NPIs in your scope</p>
                    </div>
                </div>

                {pcgError ? (
                    <div className="rounded-md bg-amber-50 p-4 border border-amber-200">
                        <div className="flex">
                            <Icon name="question-mark-circled" className="h-5 w-5 text-amber-600 mt-0.5" />
                            <div className="ml-3 text-sm text-amber-800">{pcgError}</div>
                        </div>
                    </div>
                ) : null}

                {/* Provider details table (unchanged) */}
                <div className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200">
                        <h2 className="text-lg font-medium text-gray-900">Provider Details Updating</h2>
                        <p className="text-sm text-gray-500">{rows.length ? `Showing ${rows.length} NPIs` : 'No data loaded'}</p>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full table-auto divide-y divide-gray-200">
                            <thead className="bg-gray-50">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider NPI</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Submitted Transaction</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Registered for eMDR</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Electronic Only?</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Customer Name</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider Group</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Assigned To</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email IDs</th>
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
                            {!rows.length ? (
                                <tr>
                                    <td colSpan={19} className="px-6 py-8 text-center text-sm text-gray-500">
                                        No rows.
                                    </td>
                                </tr>
                            ) : (
                                rows.map((r: Row) => {
                                    const actionJson = lastUpdatedNpi === r.providerNPI ? lastUpdateResponse : undefined
                                    const persistedJson = persistedMap.get(r.providerNPI)
                                    const jsonToShow = actionJson ?? persistedJson ?? null
                                    const regStatusClass =
                                        r.reg_status?.toLowerCase().includes('register')
                                            ? 'bg-green-100 text-green-800'
                                            : r.reg_status
                                                ? 'bg-amber-100 text-amber-800'
                                                : 'bg-gray-100 text-gray-800'

                                    return (
                                        <tr key={`${r.provider_id}-${r.providerNPI}`} className="hover:bg-gray-50 align-top">
                                            <td className="px-6 py-4 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                            <td className="px-6 py-4 text-sm">
                                                {r.last_submitted_transaction ? <Pill text={r.last_submitted_transaction} /> : <span className="text-gray-400">—</span>}
                                            </td>
                                            <td className="px-6 py-4">
                                                <Badge yes={Boolean(r.registered_for_emdr)} />
                                            </td>
                                            <td className="px-6 py-4">
                                                <Badge yes={Boolean(r.registered_for_emdr_electronic_only)} />
                                            </td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.customerName ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.providerGroupName ?? '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.assignedToUsernames?.length ? r.assignedToUsernames.join(', ') : '—'}</td>
                                            <td className="px-6 py-4 text-sm text-gray-700">{r.assignedToEmails?.length ? r.assignedToEmails.join(', ') : '—'}</td>
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
                                        </tr>
                                    )
                                })
                            )}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* eMDR Register/deRegister section */}
                <div className="bg-white shadow rounded-lg overflow-hidden">
                    <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-3">
                        <div className="flex-1">
                            <h2 className="text-xl font-bold text-gray-900">eMDR Register/deRegister</h2>
                            <p className="text-sm text-gray-500">Only NPIs with provider name and address are shown below. Update provider details first if needed.</p>
                        </div>

                        <Form method="post">
                            <input type="hidden" name="intent" value="fetch-registrations" />
                            <button
                                type="submit"
                                className="inline-flex items-center rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                                disabled={!rows.length || isPending}
                                title="Fetch PCG registration status/details for all providers with a Provider ID"
                            >
                                <Icon name="update" className="h-6 w-4 mr-1.5" />
                                Fetch Registration Details
                            </button>
                        </Form>
                    </div>
                    {regFetchedAt ? (
                        <div className="px-6 pt-3 text-xs text-gray-500">
                            Last fetched registration details at <span className="font-medium">{new Date(regFetchedAt).toLocaleString()}</span>
                        </div>
                    ) : null}

                    {/* --- Table 1: Not registered for eMDR --- */}
                    <div className="px-6 py-5 space-y-3">
                        <h3 className="text-xl font-bold text-gray-800 mb-3">Not registered for eMDR</h3>
                        <div className="overflow-x-auto rounded-md border border-gray-200 p-4 bg-gray-50">
                            <table className="w-full divide-y divide-gray-200 [table-layout:auto]">
                                <colgroup>
                                    <col className="w-[110px]" />              {/* NPI (fixed-ish) */}
                                    <col className="min-w-[220px]" />          {/* Name */}
                                    <col className="min-w-[160px]" />          {/* Reg Status */}
                                    <col className="min-w-[220px]" />          {/* Stage */}
                                    <col className="min-w-[140px]" />          {/* Errors */}
                                    <col className="w-[120px]" />              {/* Provider ID */}
                                    <col className="min-w-[240px]" />          {/* Actions (room for confirm box) */}
                                </colgroup>
                                <thead className="bg-blue-950">
                                <tr>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">NPI</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Name</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Reg Status</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Stage</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Errors</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Provider ID</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Actions</th>
                                </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                {notRegisteredRows.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-6 text-sm text-gray-500 text-center">
                                            None
                                        </td>
                                    </tr>
                                ) : (
                                    notRegisteredRows.map(r => {
                                        const reg = r.provider_id ? regById[r.provider_id] : undefined
                                        const { has } = buildErrorPayload(r, reg)
                                        return (
                                            <tr key={`unreg-${r.provider_id}-${r.providerNPI}`} className="align-top">
                                                <td className="px-6 py-3 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                                <td className="px-6 py-3">
                                                    <RegStatusPill r={r} reg={reg} />
                                                </td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{reg?.stage ?? r.stage ?? '—'}</td>
                                                <td className="px-6 py-3 text-xs">
                                                    {has ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) =>
                                                                setErrorPopover({
                                                                    open: true,
                                                                    title: `Errors • NPI ${r.providerNPI}`,
                                                                    data: reg ?? buildErrorPayload(r, reg).payload,
                                                                    anchorEl: e.currentTarget as HTMLElement,
                                                                })
                                                            }
                                                            className="inline-flex items-center gap-1 text-red-600 hover:underline font-medium"
                                                        >
                                                            <Icon name="question-mark-circled" className="h-3.5 w-3.5" />
                                                            View errors
                                                        </button>
                                                    ) : (
                                                        <span className="text-gray-400">—</span>
                                                    )}
                                                </td>
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
                                                        resetOn={lastAction && lastAction.ok && lastAction.npi === r.providerNPI ? lastAction.at : undefined}
                                                    />
                                                    {!r.provider_id ? <p className="mt-2 text-xs text-amber-600">Provider ID missing — update provider details first.</p> : null}
                                                </td>
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
                    <div className="px-6 py-5 space-y-3">
                        <h3 className="text-xl font-bold text-gray-800">Registered for eMDR</h3>
                        <div className="overflow-x-auto rounded-md border border-gray-200 p-4 bg-gray-50">
                            <table className="w-full divide-y divide-gray-200 [table-layout:auto]">
                                <colgroup>
                                    <col className="w-[110px]" />              {/* NPI */}
                                    <col className="min-w-[110px]" />          {/* Name */}
                                    <col className="w-[100px]" />              {/* Electronic Only? */}
                                    <col className="min-w-[160px]" />          {/* Reg Status */}
                                    <col className="min-w-[180px]" />          {/* Stage */}
                                    <col className="min-w-[110px]" />          {/* TXN IDs */}
                                    <col className="min-w-[140px]" />          {/* Errors */}
                                    <col className="w-[120px]" />              {/* Provider ID */}
                                    <col className="min-w-[260px]" />          {/* Actions */}
                                </colgroup>

                                <thead className="bg-blue-950">
                                <tr>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">NPI</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Name</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Electronic Only?</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Reg Status</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Stage</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">TXN IDs</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Errors</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Provider ID</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Actions</th>
                                </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                {registeredRows.length === 0 ? (
                                    <tr>
                                        <td colSpan={9} className="px-6 py-6 text-sm text-gray-500 text-center">
                                            None
                                        </td>
                                    </tr>
                                ) : (
                                    registeredRows.map(r => {
                                        const reg = r.provider_id ? regById[r.provider_id] : undefined
                                        const statusChanges = (reg?.status_changes ?? r.status_changes) as StatusChange[]
                                        const lastChange: StatusChange | undefined =
                                            Array.isArray(statusChanges) && statusChanges.length ? statusChanges[statusChanges.length - 1] : undefined
                                        const txnDisplay =
                                            typeof reg?.transaction_id_list === 'string'
                                                ? reg.transaction_id_list.replace(/,+$/, '')
                                                : lastChange?.esmd_transaction_id ?? toCsv(r.transaction_id_list) ?? ''
                                        const { has } = buildErrorPayload(r, reg)
                                        return (
                                            <tr key={`reg-${r.provider_id}-${r.providerNPI}`} className="align-top">
                                                <td className="px-6 py-3 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                                <td className="px-6 py-3">
                                                    <Badge yes={Boolean(r.registered_for_emdr_electronic_only)} />
                                                </td>
                                                <td className="px-6 py-3">
                                                    <RegStatusPill r={r} reg={reg} />
                                                </td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{reg?.stage ?? r.stage ?? '—'}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{txnDisplay ? <Pill text={txnDisplay} /> : <span className="text-gray-400">—</span>}</td>
                                                <td className="px-6 py-3 text-xs">
                                                    {has ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) =>
                                                                setErrorPopover({
                                                                    open: true,
                                                                    title: `Errors • NPI ${r.providerNPI}`,
                                                                    data: reg ?? buildErrorPayload(r, reg).payload,
                                                                    anchorEl: e.currentTarget as HTMLElement,
                                                                })
                                                            }
                                                            className="inline-flex items-center gap-1 text-red-600 hover:underline font-medium"
                                                        >
                                                            <Icon name="question-mark-circled" className="h-3.5 w-3.5" />
                                                            View errors
                                                        </button>
                                                    ) : (
                                                        <span className="text-gray-400">—</span>
                                                    )}
                                                </td>
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
                                                            resetOn={lastAction && lastAction.ok && lastAction.npi === r.providerNPI ? lastAction.at : undefined}
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
                                                                resetOn={lastAction && lastAction.ok && lastAction.npi === r.providerNPI ? lastAction.at : undefined}
                                                            />
                                                        ) : null}
                                                    </div>
                                                </td>
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
                    <div className="px-6 py-5 space-y-3">
                        <h3 className="text-sm font-semibold text-gray-800">Registered for Electronic-Only ADR</h3>
                        <p className="text-xs text-gray-500">To revert to standard delivery (mail + electronic), deregister and then register again.</p>
                        <div className="overflow-x-auto rounded-md border border-gray-200 p-4 bg-gray-50">
                            <table className="w-full divide-y divide-gray-200 [table-layout:auto]">
                                <colgroup>
                                    <col className="w-[110px]" />              {/* NPI */}
                                    <col className="min-w-[220px]" />          {/* Name */}
                                    <col className="min-w-[160px]" />          {/* Reg Status */}
                                    <col className="min-w-[200px]" />          {/* Stage */}
                                    <col className="min-w-[140px]" />          {/* Errors */}
                                    <col className="w-[120px]" />              {/* Provider ID */}
                                    <col className="min-w-[220px]" />          {/* Actions */}
                                </colgroup>

                                <thead className="bg-blue-950">
                                <tr>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">NPI</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Name</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Reg Status</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Stage</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Errors</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Provider ID</th>
                                    <th className="px-6 py-3 text-left text-sm font-bold text-white uppercase">Actions</th>
                                </tr>
                                </thead>
                                <tbody className="bg-white divide-y divide-gray-200">
                                {electronicOnlyRows.length === 0 ? (
                                    <tr>
                                        <td colSpan={7} className="px-6 py-6 text-sm text-gray-500 text-center">
                                            None
                                        </td>
                                    </tr>
                                ) : (
                                    electronicOnlyRows.map(r => {
                                        const reg = r.provider_id ? regById[r.provider_id] : undefined
                                        const { has } = buildErrorPayload(r, reg)
                                        return (
                                            <tr key={`eo-${r.provider_id}-${r.providerNPI}`} className="align-top">
                                                <td className="px-6 py-3 text-sm font-medium text-gray-900">{r.providerNPI}</td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{r.provider_name ?? '—'}</td>
                                                <td className="px-6 py-3">
                                                    <RegStatusPill r={r} reg={reg} />
                                                </td>
                                                <td className="px-6 py-3 text-sm text-gray-700">{reg?.stage ?? r.stage ?? '—'}</td>
                                                <td className="px-6 py-3 text-xs">
                                                    {has ? (
                                                        <button
                                                            type="button"
                                                            onClick={(e) =>
                                                                setErrorPopover({
                                                                    open: true,
                                                                    title: `Errors • NPI ${r.providerNPI}`,
                                                                    data: reg ?? buildErrorPayload(r, reg).payload,
                                                                    anchorEl: e.currentTarget as HTMLElement,
                                                                })
                                                            }
                                                            className="inline-flex items-center gap-1 text-red-600 hover:underline font-medium"
                                                        >
                                                            <Icon name="question-mark-circled" className="h-3.5 w-3.5" />
                                                            View errors
                                                        </button>
                                                    ) : (
                                                        <span className="text-gray-400">—</span>
                                                    )}
                                                </td>
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
                                                        resetOn={lastAction && lastAction.ok && lastAction.npi === r.providerNPI ? lastAction.at : undefined}
                                                    />
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
            </div>

            <StickyJsonPopover
                open={errorPopover.open}
                anchorEl={errorPopover.anchorEl || null}
                title={errorPopover.title}
                data={errorPopover.data}
                onClose={() => setErrorPopover({ open: false })}
            />

            <Drawer isOpen={drawer.open} onClose={closeDrawer} title={`Update Provider • NPI ${drawer.seed?.provider_npi ?? drawer.forNpi ?? ''}`} size="md">
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
                            <button type="button" onClick={closeDrawer} className="inline-flex items-center rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                                Cancel
                            </button>
                            <button type="submit" disabled={isPending} className="inline-flex items-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50">
                                Submit
                            </button>
                        </div>
                    </Form>
                ) : null}
            </Drawer>
        </InterexLayout>
    )
}
