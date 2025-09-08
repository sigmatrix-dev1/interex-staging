// app/routes/customer+/submissions.tsx
import { useState, useEffect } from 'react'
import { data, useLoaderData, Form, useSearchParams, useNavigation, Link,Outlet, type LoaderFunctionArgs, type ActionFunctionArgs  } from 'react-router'

import { InterexLayout } from '#app/components/interex-layout.tsx'
import { SubmissionActivityLog } from '#app/components/submission-activity-log.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Icon } from '#app/components/ui/icon.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import {
    SubmissionPurposeValues,
    formatEnum,
} from '#app/domain/submission-enums.ts'
import { pcgGetStatus } from '#app/services/pcg-hih.server.ts'
import { getAccessToken } from '#app/services/pcg-token.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'

type PcgEvent = { kind?: string; payload?: any }

export function latestStageFromPCG(s: { responseMessage?: string | null; events?: PcgEvent[] | any[] }) {
    const stageFromRow = (s.responseMessage ?? '').toString().trim()
    const stageFromEvent =
        ((s.events ?? []).find((e: any) => e?.kind === 'PCG_STATUS')?.payload?.stage ?? '').toString().trim()
    return (stageFromEvent || stageFromRow || 'Draft')
}

export async function loader({ request }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            roles: true,
            customer: true,
            providerGroup: true,
            userNpis: { include: { provider: true } },
        },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    const hasRequiredRole = user.roles.some(r =>
        ['system-admin', 'customer-admin', 'provider-group-admin', 'basic-user'].includes(r.name),
    )
    if (!hasRequiredRole) throw new Response('Insufficient permissions', { status: 403 })

    const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(r => r.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin') || isCustomerAdmin

    if (!user.customerId && !isSystemAdmin) {
        throw new Response('User must be associated with a customer', { status: 400 })
    }

    let whereClause: any = {}
    if (isSystemAdmin) {
        whereClause = {}
    } else if (user.customerId) {
        whereClause = { customerId: user.customerId }
        if (isProviderGroupAdmin && user.providerGroupId) {
            whereClause.provider = { providerGroupId: user.providerGroupId }
        } else if (!isCustomerAdmin) {
            const userProviderIds = user.userNpis.map(un => un.providerId)
            whereClause.providerId = { in: userProviderIds }
        }
    }

    const submissions = await prisma.submission.findMany({
        where: whereClause,
        include: {
            creator: { select: { id: true, username: true, name: true } },
            provider: { select: { id: true, npi: true, name: true } },
            documents: { select: { id: true, fileName: true, fileSize: true, createdAt: true } },
            events: {
                select: { id: true, kind: true, message: true, payload: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
                take: 50,
            },
        },
        orderBy: { createdAt: 'desc' },
    })

    return data({
        user,
        submissions: submissions.map(s => ({
            ...s,
            events: s.events.map(e => ({
                ...e,
                createdAt: e.createdAt.toISOString(),
            })),
        })),
    })


}

export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
            roles: true,
            customer: true,
            providerGroup: true,
            userNpis: { include: { provider: true } },
        },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    const formData = await request.formData()
    const intent = formData.get('intent')

    if (intent === 'update-status') {
        const submissionId = String(formData.get('submissionId') || '')
        const submission = await prisma.submission.findUnique({
            where: { id: submissionId },
            include: { provider: true },
        })
        if (!submission) {
            return redirectWithToast('/customer/submissions', {
                type: 'error',
                title: 'Not found',
                description: 'Submission not found',
            })
        }
        if (!submission.pcgSubmissionId) {
            return redirectWithToast('/customer/submissions', {
                type: 'error',
                title: 'Missing ID',
                description: 'Remote submission_id not available',
            })
        }

        try {
            const statusResp = await pcgGetStatus(submission.pcgSubmissionId)
            await prisma.submissionEvent.create({
                data: {
                    submissionId,
                    kind: 'PCG_STATUS',
                    message: statusResp.stage ?? 'Status retrieved',
                    payload: statusResp,
                },
            })

            await prisma.submission.update({
                where: { id: submissionId },
                data: {
                    transactionId: statusResp.esmdTransactionId ?? submission.transactionId ?? null,
                    responseMessage: statusResp.stage ?? submission.responseMessage ?? null,
                    updatedAt: new Date(),
                },
            })

            return redirectWithToast('/customer/submissions', {
                type: 'success',
                title: 'Status Updated',
                description: statusResp.stage ?? 'Latest status retrieved from PCG.',
            })
        } catch (e: any) {
            return redirectWithToast('/customer/submissions', {
                type: 'error',
                title: 'Status Update Failed',
                description: e?.message?.toString?.() ?? 'Unable to retrieve status',
            })
        }
    }

    if (intent === 'retry') {
        const submissionId = String(formData.get('submissionId') || '')
        const submission = await prisma.submission.findUnique({
            where: {id: submissionId},
            include: {
                events: {
                    select: {id: true, kind: true, createdAt: true},
                    orderBy: {createdAt: 'desc'},
                    take: 50,
                },
            },
        })

        if (!submission) {
            return redirectWithToast('/customer/submissions', {
                type: 'error',
                title: 'Not found',
                description: 'Submission not found',
            })
        }

        // Only allow Retry while the remote stage is Draft
        const stage = latestStageFromPCG(submission).toLowerCase()
        if (!stage.includes('draft')) {
            return redirectWithToast('/customer/submissions', {
                type: 'error',
                title: 'Not Editable',
                description: 'Retry is only available while the submission is in Draft.',
            })
        }

        // Decide which step to start from based on the most recent error
        const lastError = submission.events.find(e =>
            e.kind === 'PCG_UPLOAD_ERROR' ||
            e.kind === 'PCG_UPDATE_ERROR' ||
            e.kind === 'PCG_CREATE_ERROR'
        )

        // Default: if we have a remote id, Step 2; else Step 1
        let targetUrl = submission.pcgSubmissionId
            ? `/customer/submissions/${submission.id}/review`
            : `/customer/submissions/new?retry=${encodeURIComponent(submission.id)}`
        let stepLabel = submission.pcgSubmissionId ? 'Step 2' : 'Step 1'

        if (!submission.pcgSubmissionId || lastError?.kind === 'PCG_CREATE_ERROR') {
            targetUrl = `/customer/submissions/new?retry=${encodeURIComponent(submission.id)}` // Step 1 with retry prefill
            stepLabel = 'Step 1'
        } else if (lastError?.kind === 'PCG_UPDATE_ERROR') {
            targetUrl = `/customer/submissions/${submission.id}/review`             // Step 2
            stepLabel = 'Step 2'
        } else if (lastError?.kind === 'PCG_UPLOAD_ERROR') {
            targetUrl = `/customer/submissions/${submission.id}/upload`             // Step 3
            stepLabel = 'Step 3'
        }

        return redirectWithToast(targetUrl, {
            type: 'message',
            title: 'Retry',
            description: `Resuming at ${stepLabel}.`,
        })
    }

    return data({ ok: true })
}

export default function Submissions() {
    const { user, submissions } = useLoaderData<typeof loader>() as {
        user: any
        submissions: any[]
    }

    const [searchParams, setSearchParams] = useSearchParams()
    const nav = useNavigation()

    const [purposeFilter, setPurposeFilter] = useState(searchParams.get('purpose') || 'all')

    const [drawerState, setDrawerState] = useState<{
        isOpen: boolean
        selectedSubmission?: any
    }>({ isOpen: false, selectedSubmission: null })

    useEffect(() => {
        const viewId = searchParams.get('view')
        if (viewId) {
            const s = submissions.find((x: any) => x.id === viewId)
            if (s) setDrawerState({ isOpen: true, selectedSubmission: s })
        } else {
            setDrawerState({ isOpen: false, selectedSubmission: null })
        }
    }, [searchParams, submissions])

    const openViewDrawer = (s: any) => {
        const p = new URLSearchParams(searchParams)
        p.set('view', s.id)
        setSearchParams(p)
    }
    const closeDrawer = () => {
        const p = new URLSearchParams(searchParams)
        p.delete('view')
        setSearchParams(p)
    }

    const filteredSubmissions = submissions.filter((submission: any) => {
        if (purposeFilter !== 'all' && submission.purposeOfSubmission !== purposeFilter) return false
        return true
    })

    const handleFilterChange = (type: string, value: string) => {
        const sp = new URLSearchParams(searchParams)
        if (value === 'all') sp.delete(type)
        else sp.set(type, value)
        setSearchParams(sp)
        if (type === 'purpose') setPurposeFilter(value)
    }

    const getStageColor = (stage: string, hasErrorEvent: boolean) => {
        const s = (stage || 'Draft').toLowerCase()
        if (s.includes('draft')) return 'bg-gray-100 text-gray-800'
        if (hasErrorEvent) return 'bg-red-100 text-red-800'
        if (s.includes('request accepted')) return 'bg-blue-100 text-blue-800'
        if (s.includes('cloud object storage') || s.includes('s3')) return 'bg-yellow-100 text-yellow-800'
        if (s.includes('review contractor pickup')) return 'bg-green-100 text-green-800'
        return 'bg-gray-100 text-gray-800'
    }
    const formatSubmissionPurpose = (purpose: string) =>
        purpose.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
    const formatStatus = (status: string) => status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())

    function isDraftFromPCG(s: { responseMessage?: string | null; events?: PcgEvent[] | any[] }) {
        return latestStageFromPCG(s).toLowerCase().includes('draft')
    }

    const getLatestPcgStatusPayload = (events: any[] = []) => {
        const ev = events.find(e => e.kind === 'PCG_STATUS')
        return (ev?.payload as any) ?? null
    }

    const safe = (v: any, fallback = '—') =>
        v === null || v === undefined || v === '' ? fallback : v

    return (
        <>
            <InterexLayout
                user={user}
                title="Submissions"
                subtitle="Manage and track your HIH submissions"
                currentPath="/customer/submissions"
                backGuardEnabled={true}
                backGuardRedirectTo="/dashboard"
            >
                <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
                    <div className="space-y-8">
                        {/* Filters */}
                        <div className="bg-white shadow rounded-lg p-6">
                            <div className="flex flex-col gap-4 sm:flex-row">
                                <div className="flex-1">
                                    <label htmlFor="purpose-filter" className="block text-sm font-medium text-gray-700">
                                        Filter by Purpose
                                    </label>
                                    <select
                                        id="purpose-filter"
                                        value={purposeFilter}
                                        onChange={e => {
                                            const sp = new URLSearchParams(searchParams)
                                            const val = e.target.value
                                            if (val === 'all') sp.delete('purpose'); else sp.set('purpose', val)
                                            setSearchParams(sp)
                                            setPurposeFilter(val)
                                        }}
                                        className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-base text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm shadow-sm"
                                    >
                                        <option value="all">All Purposes</option>
                                        {SubmissionPurposeValues.map(p => (
                                            <option key={p} value={p}>{formatEnum(p)}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </div>

                        {/* Submissions Table */}
                        <div className="bg-white shadow rounded-lg">
                            <div className="px-6 py-4 border-b border-gray-200">
                                <div className="flex justify-between items-center">
                                    <div>
                                        <h2 className="text-lg font-medium text-gray-900">Submissions</h2>
                                        <p className="text-sm text-gray-500">
                                            {filteredSubmissions.length} submission{filteredSubmissions.length !== 1 ? 's' : ''}
                                        </p>
                                    </div>
                                    <div className="flex space-x-3">
                                        <Link
                                            to="/customer/submissions/new"
                                            className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                                        >
                                            <Icon name="plus" className="h-4 w-4 mr-2"/>
                                            Create Submission
                                        </Link>
                                    </div>
                                </div>
                            </div>

                            {filteredSubmissions.length === 0 ? (
                                <div className="px-6 py-12 text-center">
                                    <Icon name="file-text" className="h-12 w-12 text-gray-400 mx-auto mb-4"/>
                                    <h3 className="text-lg font-medium text-gray-900 mb-2">No submissions found</h3>
                                    <p className="text-gray-500 mb-6">Get started by creating your first submission.</p>
                                    <Link
                                        to="/customer/submissions/new"
                                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
                                    >
                                        <Icon name="plus" className="h-4 w-4 mr-2"/>
                                        Create Submission
                                    </Link>
                                </div>
                            ) : (
                                <div className="overflow-x-auto shadow-sm">
                                    <div className="inline-block min-w-full align-middle">
                                        <table className="min-w-full divide-y divide-gray-200 table-fixed">
                                            <colgroup>
                                                <col className="w-[28ch]"/>
                                                <col className="w-[18ch]"/>
                                                <col className="w-[22ch]"/>
                                                <col className="w-[40ch]"/>
                                                <col className="w-[12ch]"/>
                                                <col className="w-[16ch]"/>
                                                <col className="w-[12ch]"/>
                                            </colgroup>

                                            <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Title
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Purpose
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    NPI
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Stage (PCG)
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Documents
                                                </th>
                                                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                                    Created
                                                </th>
                                                <th className="relative px-4 py-3 text-right font-medium text-gray-500 " >
                                                    <span className="sr-only">Actions</span>
                                                </th>
                                            </tr>
                                            </thead>
                                            <tbody className="bg-white divide-y divide-gray-200">
                                            {filteredSubmissions.map((s: any) => (
                                                <tr key={s.id} className="hover:bg-gray-50">

                                                    <td className="px-4 py-4 align-top">
                                                        <div
                                                            className="text-sm font-medium text-gray-900 whitespace-normal break-words leading-tight"
                                                            title={s.title}
                                                        >
                                                            {s.title}
                                                        </div>
                                                        {s.claimId ? (
                                                            <div className="mt-0.5 text-xs text-gray-500 whitespace-normal break-words">
                                                                Claim: {s.claimId}
                                                            </div>
                                                        ) : null}
                                                    </td>

                                                    <td className="px-4 py-4">
                                                        <div className="text-sm text-gray-900">
                            <span
                                className="inline-block px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded-full whitespace-nowrap">
                          {formatSubmissionPurpose(s.purposeOfSubmission)}
                          </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-4">
                                                        <div className="text-sm font-mono text-gray-900">{s.provider.npi}</div>

                                                        {s.provider.name ? (
                                                            <div className="text-xs text-gray-500 whitespace-normal break-words"
                                                                 title={s.provider.name}>
                                                                {s.provider.name}
                                                            </div>
                                                        ) : null}

                                                    </td>

                                                    <td className="px-4 py-4 align-top">
                                                        {(() => {
                                                            const stage = latestStageFromPCG(s)
                                                            const hasErrorEvent = (s.events ?? []).some(
                                                                (e: any) =>
                                                                    e.kind === 'PCG_CREATE_ERROR' ||
                                                                    e.kind === 'PCG_UPDATE_ERROR' ||
                                                                    e.kind === 'PCG_UPLOAD_ERROR',
                                                            )
                                                            const badge = getStageColor(stage, hasErrorEvent)
                                                            return (
                                                                <span
                                                                    className={[
                                                                        'inline-block px-2 py-1 text-xs font-semibold rounded',
                                                                        'whitespace-normal break-words leading-tight',
                                                                        badge,
                                                                    ].join(' ')}
                                                                    title={stage}
                                                                > {stage}
                                        </span>
                                                            )
                                                        })()}
                                                    </td>

                                                    <td className="px-4 py-4">
                                                        <div className="text-sm text-gray-900 flex items-center">
                                                            <Icon name="file-text" className="h-4 w-4 mr-1 text-gray-400"/>
                                                            {s.documents.length}
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-4 text-sm text-gray-500">
                                                        <div className="flex flex-col">
                                <span className="whitespace-nowrap">
                                  {new Date(s.createdAt).toLocaleDateString()}
                                </span>
                                                            <span className="text-xs text-gray-400 whitespace-nowrap">
                                  {new Date(s.createdAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}
                                </span>
                                                        </div>
                                                    </td>
                                                    <td className="px-4 py-4 text-right w-20">
                                                        <div className="flex items-center justify-end space-x-2">
                                                            <button
                                                                onClick={() => openViewDrawer(s)}
                                                                className="inline-flex items-center px-2 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 rounded hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 whitespace-nowrap"
                                                            >
                                                                <Icon name="arrow-right" className="h-3 w-3 mr-1"/>
                                                                View
                                                            </button>

                                                            {(() => {
                                                                const stage = latestStageFromPCG(s).toLowerCase()
                                                                const isDraft = stage.includes('draft')
                                                                if (!isDraft) return null

                                                                const hasErrorEvent = (s.events ?? []).some(
                                                                    (e: any) =>
                                                                        e.kind === 'PCG_CREATE_ERROR' ||
                                                                        e.kind === 'PCG_UPDATE_ERROR' ||
                                                                        e.kind === 'PCG_UPLOAD_ERROR',
                                                                )

                                                                if (!hasErrorEvent) {
                                                                    return (
                                                                        <Link
                                                                            to={`/customer/submissions/${s.id}/review`}
                                                                            className="inline-flex items-center px-2 py-1 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 whitespace-nowrap"
                                                                        >
                                                                            Continue
                                                                        </Link>
                                                                    )
                                                                }

                                                                return (
                                                                    <Form method="POST">
                                                                        <input type="hidden" name="intent" value="retry" />
                                                                        <input type="hidden" name="submissionId" value={s.id} />
                                                                        <StatusButton
                                                                            type="submit"
                                                                            status="idle"
                                                                            className="inline-flex items-center px-2 py-1 text-xs font-medium text-white bg-amber-600 rounded hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 whitespace-nowrap"
                                                                            title="Retry from the correct step"
                                                                        >
                                                                            Retry
                                                                        </StatusButton>
                                                                    </Form>
                                                                )
                                                            })()}
                                                        </div>
                                                    </td>
                                                </tr>
                                            ))}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </InterexLayout>

            <Drawer
                isOpen={drawerState.isOpen}
                onClose={closeDrawer}
                title={
                    drawerState.selectedSubmission
                        ? `Submission: ${drawerState.selectedSubmission.title}`
                        : 'Submission'
                }
                size="fullscreen"
            >
                {drawerState.selectedSubmission ? (
                    <div className="space-y-6">
                        <div className="bg-gray-50 rounded-lg p-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {(() => {
                                    const s = drawerState.selectedSubmission
                                    const pcg = getLatestPcgStatusPayload(s.events)
                                    const stage = latestStageFromPCG(s)

                                    const txnFromPayloadList = (pcg?.transactionIdList || '')
                                        .split(',')
                                        .map((x: string) => x.trim())
                                        .filter(Boolean)
                                    const txnSingle = pcg?.esmdTransactionId || s.transactionId || null
                                    const txnIds = txnFromPayloadList.length ? txnFromPayloadList : (txnSingle ? [txnSingle] : [])

                                    const intended = pcg?.intendedRecipient
                                    const purpose = pcg?.purposeOfSubmission

                                    const docSet: Array<any> = Array.isArray(pcg?.documentSet) ? pcg.documentSet : []
                                    const statusChanges: Array<any> = Array.isArray(pcg?.statusChanges) ? pcg.statusChanges : []

                                    const safe = (v: any, fallback = '—') =>
                                        v === null || v === undefined || v === '' ? fallback : v

                                    return (
                                        <>
                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">Title</label>
                                                <p className="text-sm text-gray-900">{s.title}</p>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">Stage (from PCG)</label>
                                                <p className="text-sm text-gray-900">{stage}</p>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">PCG submission_id</label>
                                                <p className="text-sm font-mono text-gray-900">{safe(s.pcgSubmissionId)}</p>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">esMD Transaction ID(s)</label>
                                                <div className="text-sm text-gray-900 space-y-1">
                                                    {txnIds.length ? (
                                                        txnIds.map((id: string) => (
                                                            <div key={id} className="font-mono break-all">{id}</div>
                                                        ))
                                                    ) : (
                                                        <span>—</span>
                                                    )}
                                                </div>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">Purpose</label>
                                                <p className="text-sm text-gray-900">
                                                    {safe(purpose?.name || s.purposeOfSubmission)}
                                                </p>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">Recipient</label>
                                                <p className="text-sm text-gray-900">
                                                    {intended?.name ? `${intended.name}` : safe(s.recipient)}
                                                    {intended?.oid ? (
                                                        <span className="ml-2 inline-block rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-gray-700">
                                    {intended.oid}
                                  </span>
                                                    ) : null}
                                                </p>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">Author NPI</label>
                                                <p className="text-sm text-gray-900 font-mono">{safe(pcg?.authorNPI || s.provider.npi)}</p>
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">Auto Split</label>
                                                <p className="text-sm text-gray-900">{String(Boolean(pcg?.autoSplit ?? s.autoSplit))}</p>
                                            </div>

                                            <div className="md:col-span-2">
                                                <label className="block text-sm font-medium text-gray-700">Document Set</label>
                                                {docSet.length ? (
                                                    <ul className="mt-1 text-sm text-gray-900 list-disc list-inside space-y-1">
                                                        {docSet.map((d, i) => (
                                                            <li key={`${i}-${d.filename || d.name || 'doc'}`}>
                                                                <span className="font-mono">{safe(d.filename || d.name)}</span>
                                                                {d.split_no ? <span className="ml-2 text-xs text-gray-500">split #{d.split_no}</span> : null}
                                                                {d.attachmentControlNum ? <span className="ml-2 text-xs text-gray-500">ACN {d.attachmentControlNum}</span> : null}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                ) : (
                                                    <p className="mt-1 text-sm text-gray-900">—</p>
                                                )}
                                            </div>

                                            <div>
                                                <label className="block text-sm font-medium text-gray-700">Created</label>
                                                <p className="text-sm text-gray-900">
                                                    {new Date(s.createdAt).toLocaleDateString()}
                                                </p>
                                            </div>

                                            <div className="md:col-span-2">
                                                <label className="block text-sm font-medium text-gray-700">Status Timeline</label>
                                                {statusChanges.length ? (
                                                    <div className="mt-2 overflow-hidden rounded border border-gray-200">
                                                        <table className="min-w-full divide-y divide-gray-200">
                                                            <thead className="bg-gray-50">
                                                            <tr>
                                                                <th className="px-3 py-2 text-left text-xs font-medium bold text-gray-900 tracking-wider">Time</th>
                                                                <th className="px-3 py-2 text-left text-xs font-medium bold text-gray-900 tracking-wider">Title</th>
                                                                <th className="px-3 py-2 text-left text-xs font-medium bold text-gray-900 tracking-wider">Status</th>
                                                                <th className="px-3 py-2 text-left text-xs font-medium bold text-gray-900 tracking-wider">esMD Txn ID</th>
                                                                <th className="px-3 py-2 text-left text-xs font-medium text-gray-900 tracking-wider">Split</th>
                                                            </tr>
                                                            </thead>
                                                            <tbody className="bg-white divide-y divide-gray-200">
                                                            {statusChanges.map((c, idx) => (
                                                                <tr key={idx}>
                                                                    <td className="px-3 py-2 text-sm text-gray-900 whitespace-nowrap">{safe(c.time)}</td>
                                                                    <td className="px-3 py-2 text-sm text-gray-900">{safe(c.title)}</td>
                                                                    <td className="px-3 py-2 text-sm text-gray-900">{safe(c.status)}</td>
                                                                    <td className="px-3 py-2 text-sm font-mono text-gray-900 break-all">{safe(c.esmd_transaction_id)}</td>
                                                                    <td className="px-3 py-2 text-sm text-gray-900">{safe(c.split_number)}</td>
                                                                </tr>
                                                            ))}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                ) : (
                                                    <p className="mt-1 text-sm text-gray-900">—</p>
                                                )}
                                            </div>
                                        </>
                                    )
                                })()}
                            </div>

                            <div className="mt-4 flex justify-end">
                                <Form method="POST">
                                    <input type="hidden" name="intent" value="update-status"/>
                                    <input type="hidden" name="submissionId" value={drawerState.selectedSubmission.id}/>
                                    <StatusButton
                                        type="submit"
                                        disabled={nav.state !== 'idle' && nav.formData?.get('intent') === 'update-status'}
                                        status={
                                            nav.state !== 'idle' && nav.formData?.get('intent') === 'update-status' ? 'pending' : 'idle'
                                        }
                                        className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500"
                                    >
                                        Update status
                                    </StatusButton>
                                </Form>
                            </div>
                        </div>

                        <SubmissionActivityLog events={drawerState.selectedSubmission.events ?? []}/>
                    </div>
                ) : null}
            </Drawer>
            <Outlet/>
        </>
    )
}
