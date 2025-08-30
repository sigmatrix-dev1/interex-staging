// app/routes/customer+/letters.tsx
import * as React from 'react'
import {
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
    data,
    useLoaderData,
    Form,
} from 'react-router'

import { prisma } from '#app/utils/db.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { requireRoles } from '#app/utils/role-redirect.server.ts'
import { INTEREX_ROLES } from '#app/utils/interex-roles.ts'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { JsonViewer } from '#app/components/json-view.tsx'
import { useIsPending } from '#app/utils/misc.tsx'
import { syncLetters, downloadLetterPdf } from '#app/services/letters.server.ts'

type TabType = 'PREPAY' | 'POSTPAY' | 'POSTPAY_OTHER'

export async function loader({ request }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            customerId: true,
            roles: { select: { name: true } },
        },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    // Allow Customer Admin, Provider Group Admin, and Basic User to view
    requireRoles(user, [
        INTEREX_ROLES.CUSTOMER_ADMIN,
        INTEREX_ROLES.PROVIDER_GROUP_ADMIN,
        INTEREX_ROLES.BASIC_USER,
    ])
    if (!user.customerId) throw new Response('User must be associated with a customer', { status: 400 })

    const url = new URL(request.url)
    const type = (url.searchParams.get('type') as TabType) ?? 'PREPAY'
    const search = url.searchParams.get('search')?.trim() || ''

    const baseWhere: any = { customerId: user.customerId }
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

    let letters: any[] = []

    if (type === 'PREPAY') {
        letters = await prisma.prepayLetter.findMany({
            where: baseWhere,
            include: commonInclude,
            orderBy: [{ letterDate: 'desc' }, { createdAt: 'desc' }],
            take: 500,
        })
    } else if (type === 'POSTPAY') {
        letters = await prisma.postpayLetter.findMany({
            where: baseWhere,
            include: commonInclude,
            orderBy: [{ letterDate: 'desc' }, { createdAt: 'desc' }],
            take: 500,
        })
    } else {
        letters = await prisma.postpayOtherLetter.findMany({
            where: baseWhere,
            include: commonInclude,
            orderBy: [{ letterDate: 'desc' }, { createdAt: 'desc' }],
            take: 500,
        })
    }

    return data({ user, type, letters })
}

export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            customerId: true,
            roles: { select: { name: true } },
        },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    const form = await request.formData()
    const intent = String(form.get('intent') || '')

    if (intent === 'sync') {
        // Only Customer Admins can sync
        requireRoles(user, [INTEREX_ROLES.CUSTOMER_ADMIN])
        const type = String(form.get('type')) as TabType
        const startDate = String(form.get('startDate') || '')
        const endDate = String(form.get('endDate') || '')
        const types: TabType[] = type ? [type] : ['PREPAY', 'POSTPAY', 'POSTPAY_OTHER']
        await syncLetters({ startDate, endDate, types })
        return data({ ok: true })
    }

    if (intent === 'download') {
        // All allowed viewers can download
        requireRoles(user, [
            INTEREX_ROLES.CUSTOMER_ADMIN,
            INTEREX_ROLES.PROVIDER_GROUP_ADMIN,
            INTEREX_ROLES.BASIC_USER,
        ])
        const type = String(form.get('type')) as TabType
        const externalLetterId = String(form.get('externalLetterId') || '')
        const { fileBase64, filename } = await downloadLetterPdf({ type, externalLetterId })
        if (!fileBase64) return data({ error: 'No file returned' }, { status: 400 })
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

export default function CustomerLettersPage() {
    const { user, type, letters } = useLoaderData<typeof loader>()
    const isPending = useIsPending()

    const assignedUsers = (row: any) =>
        row?.provider?.userNpis?.map((x: any) => x.user.username).filter(Boolean).join(', ') || '—'

    const canSync = user.roles.some(r => r.name === INTEREX_ROLES.CUSTOMER_ADMIN)

    return (
        <InterexLayout
            user={user}
            title="Letters"
            subtitle="Letters for your organization"
            showBackButton
            backTo="/customer"
            currentPath="/customer/letters"
        >
            <LoadingOverlay show={Boolean(isPending)} />

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-4">
                <div className="bg-white shadow rounded-md p-4 flex flex-wrap items-end gap-4">
                    <Form method="get" className="flex flex-wrap items-end gap-3">
                        <div className="flex flex-col">
                            <label className="text-xs text-gray-500">Type</label>
                            <select name="type" defaultValue={type} className="border rounded px-2 py-1 text-sm" onChange={(e)=>e.currentTarget.form?.submit()}>
                                <option value="PREPAY">Pre-pay</option>
                                <option value="POSTPAY">Post-pay</option>
                                <option value="POSTPAY_OTHER">Post-pay (Other)</option>
                            </select>
                        </div>
                        <div className="flex flex-col">
                            <label className="text-xs text-gray-500">Search</label>
                            <input name="search" placeholder="NPI / Letter ID / Program…" className="border rounded px-2 py-1 text-sm" />
                        </div>
                        <button className="bg-gray-800 text-white text-sm rounded px-3 py-1.5">Apply</button>
                    </Form>

                    {canSync && (
                        <Form method="post" className="ml-auto flex items-end gap-3">
                            <input type="hidden" name="intent" value="sync" />
                            <input type="hidden" name="type" value={type} />
                            <div>
                                <label className="block text-xs text-gray-500">Start date</label>
                                <input type="date" name="startDate" required className="border rounded px-2 py-1 text-sm" />
                            </div>
                            <div>
                                <label className="block text-xs text-gray-500">End date</label>
                                <input type="date" name="endDate" required className="border rounded px-2 py-1 text-sm" />
                            </div>
                            <button className="bg-blue-600 text-white text-sm font-semibold rounded px-3 py-1.5 disabled:opacity-50">
                                <Icon name="refresh" className="inline h-4 w-4 mr-1" />
                                Fetch new letters
                            </button>
                        </Form>
                    )}
                </div>

                <div className="bg-white shadow rounded-md overflow-x-auto">
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
                        {letters.length === 0 ? (
                            <tr><td colSpan={13} className="px-4 py-6 text-sm text-gray-500 text-center">No letters found.</td></tr>
                        ) : letters.map((row: any) => (
                            <tr key={row.externalLetterId} className="hover:bg-gray-50">
                                <td className="px-4 py-2 text-sm font-mono">{row.externalLetterId}</td>
                                <td className="px-4 py-2 text-sm">{row.providerNpi}</td>
                                <td className="px-4 py-2 text-sm">{row.provider?.name ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">{row.customer?.name ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">{row.provider?.providerGroup?.name ?? '—'}</td>
                                <td className="px-4 py-2 text-sm">
                                    {row?.provider?.userNpis?.map((x: any) => x.user.username).filter(Boolean).join(', ') || '—'}
                                </td>
                                <td className="px-4 py-2 text-sm">{row.letterDate ? new Date(row.letterDate).toLocaleDateString() : '—'}</td>
                                <td className="px-4 py-2 text-sm">{row.respondBy ? new Date(row.respondBy).toLocaleDateString() : '—'}</td>
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
        </InterexLayout>
    )
}
