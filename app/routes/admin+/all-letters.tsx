// app/routes/admin+/all-letters.tsx
import * as React from 'react'
import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
    data,
    useLoaderData,
    Form,
} from 'react-router'

import { InterexLayout } from '#app/components/interex-layout.tsx'
import { JsonViewer } from '#app/components/json-view.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { syncLetters, downloadLetterPdf } from '#app/services/letters.server.ts'
import { audit } from '#app/utils/audit.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { useIsPending } from '#app/utils/misc.tsx'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { Prisma } from '@prisma/client'

type TabType = 'PREPAY' | 'POSTPAY' | 'POSTPAY_OTHER'

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

    // ✅ Only System Admins can post
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
            await audit({
                request,
                user,
                action: 'LETTERS_SYNC',
                entityType: 'LETTER',
                success: true,
                message: `Admin synced ${types.join(', ')} from ${startDate} to ${endDate}`,
                meta: { types, startDate, endDate } as Prisma.JsonValue,
            })
            return data({ ok: true })
        } catch (err: any) {
            await audit({
                request,
                user,
                action: 'LETTERS_SYNC',
                entityType: 'LETTER',
                success: false,
                message: err?.message || 'Sync failed',
                meta: { types, startDate, endDate, error: String(err?.message || err) } as Prisma.JsonValue,
            })
            throw err
        }
    }

    if (intent === 'download') {
        const type = String(form.get('type')) as TabType
        const externalLetterId = String(form.get('externalLetterId') || '')
        const { fileBase64, filename } = await downloadLetterPdf({ type, externalLetterId })
        if (!fileBase64) return data({ error: 'No file returned' }, { status: 400 })
        await audit({
            request,
            user,
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
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': String(buf.length),
            },
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

    // yyyy-MM-DD defaults: start = 30 days ago, end = today
    const today = React.useMemo(() => new Date(), [])
    const endDefault = React.useMemo(() => today.toISOString().slice(0, 10), [today])
    const startDefault = React.useMemo(() => {
        const d = new Date(today)
        d.setDate(d.getDate() - 30)
        return d.toISOString().slice(0, 10)
    }, [today])

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
        return (
            <Form method="post" className="ml-auto flex items-end gap-3">
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
                <button className="bg-blue-600 text-white text-sm font-semibold rounded px-3 py-1.5 disabled:opacity-50">
                    <Icon name="update" className="inline h-4 w-4 mr-1" />
                    Fetch new letters
                </button>
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
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Letter ID</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">NPI</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Customer</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Provider Group</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Assigned To</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Letter Date</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Respond By</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Jurisdiction</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Program</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Stage</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">PDF</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Raw</th>
                        </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                        {rows.length === 0 ? (
                            <tr><td colSpan={13} className="px-4 py-6 text-sm text-gray-500 text-center">No letters found.</td></tr>
                        ) : rows.map((row: any) => (
                            <tr key={row.externalLetterId} className="hover:bg-gray-50">
                                <td className="px-4 py-2 text-sm font-mono">{row.externalLetterId}</td>
                                <td className="px-4 py-2 text-sm">{row.providerNpi}</td>
                                <td className="px-4 py-2 text-sm">{row.provider?.name ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">{row.customer?.name ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">{row.provider?.providerGroup?.name ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">
                                    {row?.provider?.userNpis?.map((x: any) => x.user.username).filter(Boolean).join(', ') || '—'}
                                </td>
                                <td className="px-4 py-2 text-sm">
                                    {row.letterDate ? new Date(row.letterDate).toISOString().slice(0, 10) : '—'}
                                </td>
                                <td className="px-4 py-2 text-sm">
                                    {row.respondBy ? new Date(row.respondBy).toISOString().slice(0, 10) : '—'}
                                </td>
                                <td className="px-4 py-2 text-sm">{row.jurisdiction ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">{row.programName ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">{row.stage ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">
                                    <Form method="post">
                                        <input type="hidden" name="intent" value="download" />
                                        <input type="hidden" name="type" value={type} />
                                        <input type="hidden" name="externalLetterId" value={row.externalLetterId} />
                                        <button className="text-blue-600 hover:text-blue-800">Download</button>
                                    </Form>
                                </td>
                                <td className="px-4 py-2 text-sm">
                                    <JsonViewer data={row.raw} />
                                </td>
                            </tr>
                        ))}
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
