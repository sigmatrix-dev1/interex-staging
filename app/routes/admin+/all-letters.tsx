// app/routes/admin+/all-letters.tsx
import * as React from 'react'
import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
    data,
    useLoaderData,
    Form,
    useFetcher,
} from 'react-router'

import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { audit } from '#app/services/audit.server.ts'
import { syncLetters, downloadLetterPdf } from '#app/services/letters.server.ts'
import { pcgDownloadEmdrLetterFile } from '#app/services/pcg-hih.server.ts'
import { sanitizeLetterSyncMeta } from '#app/utils/audit-sanitize.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'

type TabType = 'PREPAY' | 'POSTPAY' | 'POSTPAY_OTHER'

function writeAdminAudit(request: Request, user: { id: string; name?: string | null; roles: { name: string }[] }, opts: {
    action: string
    success: boolean
    message?: string | null
    entityType?: string | null
    entityId?: string | null
    meta?: any
}) {
    const route = new URL(request.url).pathname
    let safeMeta: any = undefined
    if (opts.meta && Array.isArray(opts.meta?.types)) {
        try {
            safeMeta = sanitizeLetterSyncMeta({
                types: opts.meta.types,
                startDate: opts.meta.startDate,
                endDate: opts.meta.endDate,
                rawCountByType: opts.meta.counts,
            })
        } catch {}
    }
    return audit.admin({
        action: opts.action,
        actorType: 'USER',
        actorId: user.id,
        actorDisplay: user.name || null,
        status: opts.success ? 'SUCCESS' : 'FAILURE',
        entityType: opts.entityType || null,
        entityId: opts.entityId || null,
        summary: opts.message || null,
        metadata: {
            route,
            roles: user.roles.map(r => r.name),
            letterSync: safeMeta ?? undefined,
        },
    })
}

export async function loader({ request }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, roles: { select: { name: true } } },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })
    requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

    const url = new URL(request.url)
    const customerId = url.searchParams.get('customerId') || undefined
    const search = url.searchParams.get('search')?.trim() || ''

    const customers = await prisma.customer.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
    })

    const baseWhere: any = {}
    if (customerId) baseWhere.customerId = customerId
    if (search) {
        baseWhere.OR = [
            { externalLetterId: { contains: search } },
            { downloadId: { contains: search } }, // allow searching by the API letter id (e.g., 78562)
            { providerNpi: { contains: search } },
            { programName: { contains: search } },
            { jurisdiction: { contains: search } },
        ]
    }

    const commonInclude = {
        customer: { select: { name: true } },
        provider: {
            select: {
                name: true,
                providerGroup: { select: { name: true } },
                userNpis: { select: { user: { select: { username: true } } } },
            },
        },
    } as const
    const commonOrder = [{ letterDate: 'desc' }, { createdAt: 'desc' }] as const

    const [prepayLetters, postpayLetters, postpayOtherLetters] = await Promise.all([
        prisma.prepayLetter.findMany({
            where: baseWhere,
            include: commonInclude,
            orderBy: commonOrder as any,
            take: 500,
        }),
        prisma.postpayLetter.findMany({
            where: baseWhere,
            include: commonInclude,
            orderBy: commonOrder as any,
            take: 500,
        }),
        prisma.postpayOtherLetter.findMany({
            where: baseWhere,
            include: commonInclude,
            orderBy: commonOrder as any,
            take: 500,
        }),
    ])

    return data({
        user,
        customers,
        customerId: customerId ?? '',
        search,
        prepayLetters,
        postpayLetters,
        postpayOtherLetters,
    })
}

export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, roles: { select: { name: true } } },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })
    requireRoles(user, [INTEREX_ROLES.SYSTEM_ADMIN])

    const form = await request.formData()
    const intent = String(form.get('intent') || '')

    if (intent === 'sync') {
        const type = String(form.get('type')) as TabType
        const startDate = String(form.get('startDate') || '')
        const endDate = String(form.get('endDate') || '')
        const types: TabType[] = type ? [type] : ['PREPAY', 'POSTPAY', 'POSTPAY_OTHER']
        try {
            await syncLetters({ startDate, endDate, types })
            await writeAdminAudit(request, user, {
                action: 'LETTERS_SYNC',
                entityType: 'LETTER',
                success: true,
                message: `Admin synced ${types.join(', ')} from ${startDate} to ${endDate}`,
                meta: { types, startDate, endDate },
            })
            return data({ ok: true })
        } catch (err: any) {
            await writeAdminAudit(request, user, {
                action: 'LETTERS_SYNC',
                entityType: 'LETTER',
                success: false,
                message: err?.message || 'Sync failed',
                meta: { types, startDate, endDate, error: String(err?.message || err) },
            })
            throw err
        }
    }

    // Keep the file-streaming route available (not used by UI now, but harmless)
    if (intent === 'download') {
        const type = String(form.get('type')) as TabType
        const externalLetterId = String(form.get('externalLetterId') || '')
        const display = (String(form.get('display') || 'attachment').toLowerCase() === 'inline'
            ? 'inline'
            : 'attachment') as 'inline' | 'attachment'

        const { fileBase64, filename } = await downloadLetterPdf({ type, externalLetterId })
        if (!fileBase64) return data({ error: 'No file returned' }, { status: 400 })
        await writeAdminAudit(request, user, {
            action: 'LETTER_DOWNLOAD',
            entityType: 'LETTER',
            entityId: externalLetterId,
            success: true,
            message: `Admin downloaded ${type} letter ${externalLetterId}`,
        })
        const buf = Buffer.from(fileBase64, 'base64')
        return new Response(buf, {
            headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `${display}; filename="${filename}"`,
                'Content-Length': String(buf.length),
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            },
        })
    }

    // Used by the UI to fetch file_content AND stamp first view once
    if (intent === 'download-json') {
        const type = String(form.get('type')) as TabType
        const externalLetterId = String(form.get('externalLetterId') || '')

        let row: any = null
        if (type === 'PREPAY') {
            row = await prisma.prepayLetter.findUnique({ where: { externalLetterId } })
            if (!row) return data({ ok: false, error: 'Letter not found' }, { status: 404 })
            // NEW: stamp firstViewedAt once
            await prisma.prepayLetter.updateMany({
                where: { externalLetterId, firstViewedAt: null },
                data: { firstViewedAt: new Date() },
            })
        } else if (type === 'POSTPAY') {
            row = await prisma.postpayLetter.findUnique({ where: { externalLetterId } })
            if (!row) return data({ ok: false, error: 'Letter not found' }, { status: 404 })
            await prisma.postpayLetter.updateMany({
                where: { externalLetterId, firstViewedAt: null },
                data: { firstViewedAt: new Date() },
            })
        } else {
            row = await prisma.postpayOtherLetter.findUnique({ where: { externalLetterId } })
            if (!row) return data({ ok: false, error: 'Letter not found' }, { status: 404 })
            await prisma.postpayOtherLetter.updateMany({
                where: { externalLetterId, firstViewedAt: null },
                data: { firstViewedAt: new Date() },
            })
        }

        const letter_id = row.downloadId ?? row.externalLetterId
        const payload = await pcgDownloadEmdrLetterFile({ letter_id, letter_type: type })
        return data({
            ok: true,
            meta: { type, externalLetterId, letter_id },
            payload,
        })
    }

    return data({ error: 'invalid action' }, { status: 400 })
}

export default function AdminAllLettersPage() {
    const {
        user,
        customers,
        customerId,
        search,
        prepayLetters,
        postpayLetters,
        postpayOtherLetters,
    } = useLoaderData<typeof loader>()
    const isPending = useIsPending()

    // ===== client-side state =====
    const jsonFetcher = useFetcher()
    const [loadingId, setLoadingId] = React.useState<string | null>(null)
    // Dedupe guard to avoid double-open (e.g., StrictMode)
    const pendingIds = React.useRef<Record<string, true>>({})

    // Track first-view locally so the table can reflect it immediately after a "View"
    const [firstViewedAtById, setFirstViewedAtById] = React.useState<Record<string, string>>({})

    // NEW: last sync meta PER TYPE (Eastern + local + trigger)
    type SyncTrigger = 'manual' | 'auto'
    type SyncMeta = {
        trigger: SyncTrigger
        whenUtc: string
        whenEastern: string
        whenLocal: string
    }
    function isSyncMeta(val: unknown): val is SyncMeta {
        if (!val || typeof val !== 'object') return false
        const v = val as Record<string, unknown>
        return (
            (v.trigger === 'manual' || v.trigger === 'auto') &&
            typeof v.whenUtc === 'string' &&
            typeof v.whenEastern === 'string' &&
            typeof v.whenLocal === 'string'
        )
    }
    const [lastSyncMetaByType, setLastSyncMetaByType] = React.useState<
        Record<TabType, SyncMeta | null>
    >({
        PREPAY: null,
        POSTPAY: null,
        POSTPAY_OTHER: null,
    })

    // Load previously recorded per-type times from localStorage on mount
    React.useEffect(() => {
        try {
            const types: TabType[] = ['PREPAY', 'POSTPAY', 'POSTPAY_OTHER']
            const next: Record<TabType, SyncMeta | null> = {
                PREPAY: null,
                POSTPAY: null,
                POSTPAY_OTHER: null,
            }
            for (const t of types) {
                const raw = typeof window !== 'undefined' ? localStorage.getItem(`emdr.sync.last.${t}`) : null
                if (raw) {
                    const parsed = JSON.parse(raw) as unknown
                    if (isSyncMeta(parsed)) {
                        next[t] = parsed
                    }
                }
            }
            setLastSyncMetaByType(next)
        } catch {
            // ignore
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Helper to record a sync trigger moment for a specific type
    function recordSyncTrigger(type: TabType, source: SyncTrigger) {
        const now = new Date()
        const whenEastern = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZoneName: 'short',
        }).format(now)
        const whenLocal = new Intl.DateTimeFormat(undefined, {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZoneName: 'short',
        }).format(now)

        const payload: SyncMeta = {
            trigger: source,
            whenUtc: now.toISOString(),
            whenEastern,
            whenLocal,
        }
        try {
            localStorage.setItem(`emdr.sync.last.${type}`, JSON.stringify(payload))
        } catch {
            // ignore storage failures
        }
        setLastSyncMetaByType(prev => ({ ...prev, [type]: payload }))
    }

    React.useEffect(() => {
        const d: any = jsonFetcher.data
        if (!d) return
        if (d.ok && d.meta?.externalLetterId) {
            const id = String(d.meta.externalLetterId)

            // Only act if this id is currently pending (prevents duplicate opens)
            if (!pendingIds.current[id]) return
            delete pendingIds.current[id]
            setLoadingId(null)

            try {
                const base64: string | undefined = d.payload?.file_content
                if (!base64) {
                    alert('No file returned from API.')
                    return
                }
                const blob = base64ToPdfBlob(base64)
                const url = URL.createObjectURL(blob)

                // Open exactly once; no extra fallbacks
                window.open(url, '_blank', 'noopener')

                // Record first-view client-side (server is already stamped)
                setFirstViewedAtById(prev => (prev[id] ? prev : { ...prev, [id]: new Date().toISOString() }))

                // Cleanup
                setTimeout(() => URL.revokeObjectURL(url), 60_000)
            } catch (e) {
                console.error(e)
                alert('Failed to render PDF in browser.')
            }
        }
    }, [jsonFetcher.data])

    function requestViewJson(type: TabType, externalLetterId: string) {
        setLoadingId(externalLetterId)
        pendingIds.current[externalLetterId] = true
        void jsonFetcher.submit(
            { intent: 'download-json', type, externalLetterId },
            { method: 'post' },
        )
    }

    function base64ToPdfBlob(b64: string) {
        // tolerate "data:application/pdf;base64,..." and whitespace/newlines
        const part = b64.includes(',') ? (b64.split(',')[1] ?? b64) : b64
        const clean = part.replace(/\s/g, '').trim()
        const byteString = atob(clean)
        const len = byteString.length
        const bytes = new Uint8Array(len)
        for (let i = 0; i < len; i++) bytes[i] = byteString.charCodeAt(i)
        return new Blob([bytes], { type: 'application/pdf' })
    }

    // yyyy-MM-DD defaults: start = 30 days ago, end = today
    const today = React.useMemo(() => new Date(), [])
    const endDefault = React.useMemo(() => today.toISOString().slice(0, 10), [today])
    const startDefault = React.useMemo(() => {
        const d = new Date(today)
        d.setDate(d.getDate() - 30)
        return d.toISOString().slice(0, 10)
    }, [today])

    // Formatter + helper for Eastern Time display
    const etFormatter = React.useMemo(
        () =>
            new Intl.DateTimeFormat('en-US', {
                timeZone: 'America/New_York',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
                timeZoneName: 'short',
            }),
        [],
    )
    function formatET(input?: string | Date | null) {
        if (!input) return '—'
        const d = new Date(input)
        if (isNaN(d.getTime())) return '—'
        return etFormatter.format(d)
    }

    // Convert a Date to the UTC epoch representing the same *wall clock time in ET*
    const toEtEpochMs = React.useCallback((input?: string | Date | null) => {
        if (!input) return NaN
        const d = new Date(input)
        if (isNaN(d.getTime())) return NaN
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        }).formatToParts(d)
        const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? '0')
        return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    }, [])

    function daysLeftEtParts(respondBy?: string | Date | null) {
        if (!respondBy) return { label: '—', cls: 'bg-gray-100 text-gray-700 ring-gray-200' }
        const nowMs = toEtEpochMs(new Date())
        const dueMs = toEtEpochMs(respondBy)
        if (Number.isNaN(nowMs) || Number.isNaN(dueMs)) {
            return { label: '—', cls: 'bg-gray-100 text-gray-700 ring-gray-200' }
        }
        const MS_DAY = 24 * 60 * 60 * 1000
        const days = Math.ceil((dueMs - nowMs) / MS_DAY) // may be negative if overdue

        let cls =
            'bg-emerald-100 text-emerald-700 ring-emerald-200' // default: comfortably far
        if (days <= 30) cls = 'bg-lime-100 text-lime-700 ring-lime-200'
        if (days <= 14) cls = 'bg-yellow-100 text-yellow-700 ring-yellow-200'
        if (days <= 7) cls = 'bg-amber-100 text-amber-700 ring-amber-200'
        if (days <= 3) cls = 'bg-orange-100 text-orange-700 ring-orange-200'
        if (days <= 0) cls = 'bg-red-100 text-red-700 ring-red-200'

        return { label: `${days} - ${formatET(respondBy)}`, cls }
    }

    function FilterBar() {
        return (
            <div className="bg-white shadow rounded-md p-4 flex flex-wrap items-end gap-4">
                <Form method="get" className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-col">
                        <label className="text-xs text-gray-500">Customer</label>
                        <select
                            name="customerId"
                            defaultValue={customerId}
                            className="border rounded px-2 py-1 text-sm"
                            onChange={(e) => e.currentTarget.form?.submit()}
                        >
                            <option value="">All customers</option>
                            {customers.map(c => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex flex-col">
                        <label className="text-xs text-gray-500">Search</label>
                        <input
                            name="search"
                            defaultValue={search}
                            placeholder="NPI / Letter ID / Program…"
                            className="border rounded px-2 py-1 text-sm"
                        />
                    </div>
                    <button className="bg-gray-800 text-white text-sm rounded px-3 py-1.5">Apply</button>
                </Form>
            </div>
        )
    }

    function SyncBar({ type }: { type: TabType }) {
        const meta = lastSyncMetaByType[type]
        return (
            <Form
                method="post"
                className="ml-auto flex items-end gap-3"
                onSubmit={() => {
                    // Record time+zone for THIS type as soon as user triggers the sync
                    recordSyncTrigger(type, 'manual')
                }}
            >
                <input type="hidden" name="intent" value="sync" />
                <input type="hidden" name="type" value={type} />
                <div>
                    <label className="block text-xs text-gray-500">Start date</label>
                    <input
                        type="date"
                        name="startDate"
                        required
                        defaultValue={startDefault}
                        className="border rounded px-2 py-1 text-sm"
                    />
                </div>
                <div>
                    <label className="block text-xs text-gray-500">End date</label>
                    <input
                        type="date"
                        name="endDate"
                        required
                        defaultValue={endDefault}
                        className="border rounded px-2 py-1 text-sm"
                    />
                </div>
                <div className="flex flex-col items-start">
                    <button className="bg-blue-600 text-white text-sm font-semibold rounded px-3 py-1.5 disabled:opacity-50">
                        <Icon name="update" className="inline h-4 w-4 mr-1" />
                        Fetch new letters
                    </button>
                    {/* Two-line Last fetch display to avoid layout stretching */}
                    <div className="mt-1 text-[11px] leading-tight text-gray-500">
                        <div>
                            <span className="font-medium">Last fetch:</span>{' '}
                            {meta ? meta.whenEastern : '—'}
                        </div>
                        <div className="text-[10px] text-gray-400">
                            {meta ? `(Local: ${meta.whenLocal}) — ${meta.trigger}` : '\u00A0'}
                        </div>
                    </div>
                </div>
            </Form>
        )
    }

    function LettersTable({
                              rows,
                              type,
                              title,
                              subtitle,
                          }: {
        rows: any[]
        type: TabType
        title: string
        subtitle?: string
    }) {
        return (
            <div className="bg-white shadow rounded-md overflow-hidden">
                <div className="px-4 sm:px-6 py-3 border-b border-gray-200 flex items-center gap-3">
                    <div className="flex-1">
                        <h2 className="text-base font-semibold text-gray-900">{title}</h2>
                        {subtitle ? <p className="text-xs text-gray-500">{subtitle}</p> : null}
                    </div>
                    <SyncBar type={type} />
                </div>

                {/* Wide, scrollable table so columns don't get squished */}
                <div className="overflow-x-auto">
                    <table className="min-w-[2000px] table-fixed divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                        <tr className="whitespace-nowrap">
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[170px]">Fetched (ET)</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[140px]">Letter ID</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[320px]">Letter Name</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[140px]">NPI</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[180px]">Provider</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[160px]">Customer</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[170px]">Provider Group</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[160px]">Assigned To</th>
                            {/* moved here */}
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[100px]">PDF</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[170px]">First Viewed (ET)</th>
                            {/* remaining columns */}
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[120px]">Letter Date</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[140px]">Respond By</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[240px]">Days Left (ET)</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[120px]">Jurisdiction</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[120px]">Program</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase w-[220px]">Stage</th>
                        </tr>
                        </thead>

                        <tbody className="bg-white divide-y divide-gray-200">
                        {rows.length === 0 ? (
                            <tr>
                                <td colSpan={16} className="px-4 py-6 text-sm text-gray-500 text-center">
                                    No letters found.
                                </td>
                            </tr>
                        ) : (
                            rows.map((row: any) => {
                                const displayLetterId = row.downloadId ?? row.externalLetterId
                                const isLoading = loadingId === row.externalLetterId
                                const firstViewed = firstViewedAtById[row.externalLetterId] ?? row.firstViewedAt
                                const daysMeta = daysLeftEtParts(row.respondBy)

                                return (
                                    <tr key={row.externalLetterId} className="hover:bg-gray-50">
                                        <td
                                            className="px-4 py-2 text-sm whitespace-nowrap"
                                            title={row.createdAt ? new Date(row.createdAt).toISOString() : undefined}
                                        >
                                            {formatET(row.createdAt)}
                                        </td>

                                        <td
                                            className="px-4 py-2 text-sm font-mono whitespace-nowrap"
                                            title={row.externalLetterId ? `Unique ID: ${row.externalLetterId}` : undefined}
                                        >
                                            {displayLetterId}
                                        </td>

                                        {/* LETTER NAME now wraps */}
                                        <td className="px-4 py-2 text-sm whitespace-normal">
                                            <div className="break-words">
                                                {row.letterName ?? '—'}
                                            </div>
                                        </td>

                                        <td className="px-4 py-2 text-sm whitespace-nowrap">{row.providerNpi}</td>
                                        <td className="px-4 py-2 text-sm whitespace-nowrap">{row.provider?.name ?? '—'}</td>
                                        <td className="px-4 py-2 text-sm whitespace-nowrap">{row.customer?.name ?? '—'}</td>
                                        <td className="px-4 py-2 text-sm whitespace-nowrap">{row.provider?.providerGroup?.name ?? '—'}</td>

                                        <td className="px-4 py-2 text-sm whitespace-nowrap">
                                            {row?.provider?.userNpis?.map((x: any) => x.user.username).filter(Boolean).join(', ') || '—'}
                                        </td>

                                        {/* moved PDF + First Viewed here */}
                                        <td className="px-4 py-2 text-sm whitespace-nowrap">
                                            <Form method="post" onSubmit={(e) => e.preventDefault()}>
                                                <button
                                                    type="button"
                                                    disabled={isLoading}
                                                    onClick={() => requestViewJson(type, row.externalLetterId)}
                                                    className={[
                                                        'inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50',
                                                        isLoading
                                                            ? 'border-gray-200 bg-gray-100 text-gray-600 cursor-wait focus:ring-gray-300'
                                                            : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 focus:ring-indigo-500',
                                                    ].join(' ')}
                                                >
                                                    {isLoading ? (
                                                        <span className="inline-flex items-center gap-1">
                                                          <Icon name="update" className="h-3 w-3 animate-spin" />
                                                          Loading…
                                                        </span>
                                                    ) : (
                                                        <span>View</span>
                                                    )}
                                                </button>
                                            </Form>
                                        </td>

                                        <td
                                            className="px-4 py-2 text-sm whitespace-nowrap"
                                            title={firstViewed ? new Date(firstViewed).toISOString() : undefined}
                                        >
                                            {formatET(firstViewed)}
                                        </td>

                                        {/* remaining columns */}
                                        <td className="px-4 py-2 text-sm whitespace-nowrap">
                                            {row.letterDate ? new Date(row.letterDate).toISOString().slice(0, 10) : '—'}
                                        </td>

                                        <td className="px-4 py-2 text-sm whitespace-nowrap">
                                            {row.respondBy ? new Date(row.respondBy).toISOString().slice(0, 10) : '—'}
                                        </td>

                                        <td className="px-4 py-2 text-sm whitespace-nowrap">
                                            <span
                                                className={[
                                                    'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1',
                                                    daysMeta.cls,
                                                ].join(' ')}
                                                title="Days left — Eastern Time due date"
                                            >
                                                {daysMeta.label}
                                            </span>
                                        </td>

                                        <td className="px-4 py-2 text-sm whitespace-nowrap">{row.jurisdiction ?? '—'}</td>
                                        <td className="px-4 py-2 text-sm whitespace-nowrap">{row.programName ?? '—'}</td>
                                        <td className="px-4 py-2 text-sm whitespace-nowrap">{row.stage ?? '—'}</td>
                                    </tr>
                                )
                            })
                        )}
                        </tbody>
                    </table>
                </div>
            </div>
        )
    }

    return (
        <InterexLayout
            user={user}
            title="All eMDR Letters"
            subtitle="Central tables stored in DB; filter by customer. Separate sections per type."
            showBackButton
            backTo="/admin"
            currentPath="/admin/all-letters"
        >
            <LoadingOverlay show={Boolean(isPending)} />

            <div className="max-w-11/12 mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
                {/* Global filter (applies to all sections) */}
                <FilterBar />

                {/* PREPAY */}
                <LettersTable
                    rows={prepayLetters as any[]}
                    type="PREPAY"
                    title="Pre-pay Letters"
                />

                {/* POSTPAY */}
                <LettersTable
                    rows={postpayLetters as any[]}
                    type="POSTPAY"
                    title="Post-pay Letters"
                />

                {/* POSTPAY OTHER */}
                <LettersTable
                    rows={postpayOtherLetters as any[]}
                    type="POSTPAY_OTHER"
                    title="Post-pay Letters (Other)"
                    subtitle="These are the 'Other' category from the Post-pay feed."
                />
            </div>
        </InterexLayout>
    )
}
