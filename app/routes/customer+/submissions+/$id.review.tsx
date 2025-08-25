// app/routes/customer+/submissions+/$id.review.tsx
import { getFormProps, getInputProps, getSelectProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { SubmissionEventKind } from '@prisma/client'
import * as React from 'react'
import {
    data,
    Form,
    useActionData,
    useLoaderData,
    useNavigation,
    Link,
    useNavigate,
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { FileDropzone } from '#app/components/file-dropzone.tsx'
import { Field, SelectField, TextareaField, ErrorList } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { SubmissionActivityLog } from '#app/components/submission-activity-log.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import {
    SubmissionPurposeValues,
    SubmissionPurposeEnum,
    AuthorTypeEnum,
    formatEnum,
    RecipientOptions,
} from '#app/domain/submission-enums.ts'
import { buildCreateSubmissionPayload, pcgUpdateSubmission } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { getCachedFile, setCachedFile, moveCachedFile } from '#app/utils/file-cache.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'

function setInputValue(input: HTMLInputElement | null | undefined, value: string) {
    if (!input) return
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
}

type PcgEvent = { kind?: string; payload?: any }
type PcgStageSource = { responseMessage?: string | null; events?: PcgEvent[] | any[] }

function isDraftFromPCG(s: PcgStageSource) {
    const stageFromResponse = (s.responseMessage ?? '').toLowerCase()
    const stageFromEvent =
        ((s.events ?? []).find((e: any) => e?.kind === 'PCG_STATUS')?.payload?.stage ?? '').toLowerCase()
    const latestStage = stageFromEvent || stageFromResponse || 'Draft'
    return latestStage.includes('draft')
}

type Npi = { id: string; npi: string; name: string | null }

const UpdateSubmissionMetaSchema = z.object({
    intent: z.literal('update-submission'),
    submissionId: z.string().min(1),
    title: z.string().min(1, 'Title is required'),
    authorType: AuthorTypeEnum,
    purposeOfSubmission: SubmissionPurposeEnum,
    recipient: z.string().min(1, 'Recipient is required'),
    providerId: z.string().min(1, 'NPI selection is required'),
    claimId: z.string().min(1, 'Claim ID is required'),
    caseId: z.string().max(32).optional(),
    comments: z.string().optional(),
    autoSplit: z.enum(['true', 'false']).transform(v => v === 'true'),
    sendInX12: z.enum(['true', 'false']).transform(v => v === 'true'),
    threshold: z.preprocess(v => (v === '' ? undefined : v), z.coerce.number().int().min(1).default(100)),
    doc_name: z.string().min(1),
    doc_split_no: z.coerce.number().int().min(1).max(10).default(1),
    doc_filename: z.string().regex(/\.pdf$/i, 'Filename must end with .pdf'),
    doc_document_type: z.literal('pdf').optional().default('pdf'),
    doc_attachment: z
        .string()
        .transform(s => (typeof s === 'string' ? s.trim() : s))
        .refine(s => !!s, { message: 'Attachment Control Number is required' }),
    _initial_json: z.string().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
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

    const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(r => r.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin') || isCustomerAdmin

    const id = params.id as string
    const submission = await prisma.submission.findFirst({
        where: { id },
        include: {
            provider: { select: { id: true, npi: true, name: true } },
            events: {
                select: { id: true, kind: true, message: true, payload: true, createdAt: true },
                orderBy: { createdAt: 'desc' },
                take: 100,
            },
        },
    })
    if (!submission) throw new Response('Not found', { status: 404 })
    if (!isDraftFromPCG(submission)) {
        throw await redirectWithToast(`/customer/submissions`, {
            type: 'error',
            title: 'Not editable',
            description: 'Only draft submissions (from PCG) can be reviewed or updated.',
        })
    }
    if (!submission.pcgSubmissionId) {
        throw await redirectWithToast(`/customer/submissions/new`, {
            type: 'error',
            title: 'Missing submission_id',
            description: 'Create the submission first.',
        })
    }

    const availableNpis: Npi[] = isSystemAdmin
        ? await prisma.provider.findMany({ select: { id: true, npi: true, name: true } })
        : isCustomerAdmin && user.customerId
            ? await prisma.provider.findMany({
                where: { customerId: user.customerId },
                select: { id: true, npi: true, name: true },
            })
            : isProviderGroupAdmin && user.providerGroupId && user.customerId
                ? await prisma.provider.findMany({
                    where: { customerId: user.customerId, providerGroupId: user.providerGroupId },
                    select: { id: true, npi: true, name: true },
                })
                : user.userNpis.map(un => ({ id: un.provider.id, npi: un.provider.npi, name: un.provider.name }))

    const metaEvent =
        submission.events.find(e => e.kind === SubmissionEventKind.META_UPDATED) ??
        submission.events.find(e => e.kind === SubmissionEventKind.DRAFT_CREATED)
    const latestMeta = (metaEvent?.payload as any) ?? {}
    const doc0 = (latestMeta.document_set?.[0] ?? {}) as any

    const initial = {
        submissionId: submission.id,
        title: latestMeta?.name ?? submission.title,
        authorType:
            latestMeta?.author_type ??
            (submission.authorType?.toLowerCase() === 'institutional' ? 'institutional' : 'individual'),
        purposeOfSubmission: latestMeta?.purposeOfSubmission ?? submission.purposeOfSubmission,
        recipient: latestMeta?.intended_recepient ?? submission.recipient,
        providerId: submission.provider.id,
        claimId: latestMeta?.esMD_claim_id ?? submission.claimId ?? '',
        caseId: latestMeta?.esmd_case_id ?? submission.caseId ?? '',
        comments: latestMeta?.comments ?? submission.comments ?? '',
        autoSplit: String(Boolean(latestMeta?.auto_split ?? submission.autoSplit)),
        sendInX12: String(Boolean(latestMeta?.bSendinX12 ?? submission.sendInX12)),
        threshold: Number(latestMeta?.threshold ?? submission.threshold ?? 100),
        doc_name: doc0?.name ?? '',
        doc_split_no: Number(doc0?.split_no ?? 1),
        doc_filename: doc0?.filename ?? '',
        doc_document_type: doc0?.document_type ?? 'pdf',
        doc_attachment: doc0?.attachmentControlNum ?? '',
    }

    const eventsUi = submission.events.map(e => ({
        id: e.id,
        kind: e.kind,
        message: e.message,
        payload: e.payload,
        createdAt: e.createdAt.toISOString(),
    }))

    return data({
        user,
        submission: { ...submission, events: eventsUi },
        initial,
        initialJson: JSON.stringify(initial),
        availableNpis,
    })
}

export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const formData = await request.formData()
    const parsed = parseWithZod(formData, { schema: UpdateSubmissionMetaSchema })
    if (parsed.status !== 'success') {
        return data({ result: parsed.reply() }, { status: parsed.status === 'error' ? 400 : 200 })
    }
    const v = parsed.value

    const submission = await prisma.submission.findUnique({
        where: { id: v.submissionId },
        include: { provider: true },
    })
    if (!submission) {
        return data({ result: parsed.reply({ formErrors: ['Submission not found'] }) }, { status: 404 })
    }
    if (!isDraftFromPCG(submission)) {
        return data({ result: parsed.reply({ formErrors: ['Only draft submissions can be updated'] }) }, { status: 400 })
    }
    if (!submission.pcgSubmissionId) {
        return data({ result: parsed.reply({ formErrors: ['Remote submission_id not available'] }) }, { status: 400 })
    }

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

    const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(r => r.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin') || isCustomerAdmin

    const provider = await prisma.provider.findUnique({
        where: { id: v.providerId },
        include: { providerGroup: true },
    })

    if (!provider || (!isSystemAdmin && provider.customerId !== user.customerId)) {
        return data({ result: parsed.reply({ formErrors: ['Invalid provider (NPI) selection'] }) }, { status: 400 })
    }
    if (!isSystemAdmin) {
        if (isProviderGroupAdmin && user.providerGroupId) {
            if (provider.providerGroupId !== user.providerGroupId) {
                return data({ result: parsed.reply({ formErrors: ['Provider not in your group'] }) }, { status: 400 })
            }
        } else if (!isCustomerAdmin) {
            const hasAccess = user.userNpis.some(un => un.providerId === v.providerId)
            if (!hasAccess) {
                return data({ result: parsed.reply({ formErrors: ['You can only use NPIs assigned to you'] }) }, { status: 400 })
            }
        }
    }

    const pcgPayload = buildCreateSubmissionPayload({
        purposeOfSubmission: v.purposeOfSubmission,
        author_npi: provider.npi,
        author_type: v.authorType,
        name: v.title,
        esMD_claim_id: v.claimId ?? '',
        esmd_case_id: v.caseId ?? '',
        comments: v.comments ?? '',
        intended_recepient: v.recipient,
        auto_split: v.autoSplit,
        bSendinX12: v.sendInX12,
        threshold: v.threshold,
        document_set: [
            {
                name: v.doc_name,
                split_no: v.doc_split_no,
                filename: v.doc_filename,
                document_type: v.doc_document_type,
                attachmentControlNum: v.doc_attachment,
            },
        ],
    })

    try {
        const resp = await pcgUpdateSubmission(submission.pcgSubmissionId, pcgPayload)

        await prisma.submission.update({
            where: { id: v.submissionId },
            data: {
                title: v.title,
                purposeOfSubmission: v.purposeOfSubmission,
                recipient: v.recipient,
                claimId: v.claimId || null,
                caseId: v.caseId || null,
                comments: v.comments || null,
                autoSplit: v.autoSplit,
                sendInX12: v.sendInX12,
                threshold: v.threshold,
                authorType: v.authorType,
                providerId: v.providerId,
                updatedAt: new Date(),
            },
        })

        await prisma.submissionEvent.create({
            data: {
                submissionId: v.submissionId,
                kind: SubmissionEventKind.META_UPDATED,
                message: 'Local metadata updated',
                payload: pcgPayload,
            },
        })

        await prisma.submissionEvent.create({
            data: {
                submissionId: v.submissionId,
                kind: 'PCG_UPDATE_SUCCESS',
                message: resp?.status ?? 'update success',
                payload: { pcgSubmissionId: submission.pcgSubmissionId, response: resp },
            },
        })

        return await redirectWithToast(`/customer/submissions/${v.submissionId}/review`, {
            type: 'success',
            title: 'Submission Updated',
            description: resp?.status ?? 'PCG accepted updated metadata.',
        })
    } catch (e: any) {
        await prisma.submissionEvent.create({
            data: {
                submissionId: v.submissionId,
                kind: 'PCG_UPDATE_ERROR',
                message: e?.message?.toString?.() ?? 'Update failed',
            },
        })

        return await redirectWithToast(`/customer/submissions/${v.submissionId}/review`, {
            type: 'error',
            title: 'Update Failed',
            description: e?.message?.toString?.() ?? 'Unable to update submission metadata',
        })
    }
}

export default function ReviewSubmission() {
    const loaderData = useLoaderData<typeof loader>()
    const { user, submission, initial, initialJson } = loaderData
    const availableNpis: Npi[] = loaderData.availableNpis ?? []

    const [cached, setCached] = React.useState<File | null>(null)

    React.useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const fromNew = await getCachedFile('NEW')
                if (fromNew) await moveCachedFile('NEW', submission.id)
                const f = await getCachedFile(submission.id)
                if (alive) setCached(f)
            } catch (err) {
                console.error(err)
            }
        })()
        return () => {
            alive = false
        }
    }, [submission.id])

    const actionData = useActionData<typeof action>()
    const nav = useNavigation()
    const navigate = useNavigate()
    const isUpdating = nav.formData?.get('intent') === 'update-submission'

    const [form, fields] = useForm({
        id: 'review-submission',
        constraint: getZodConstraint(UpdateSubmissionMetaSchema),
        onValidate({ formData }) {
            return parseWithZod(formData, { schema: UpdateSubmissionMetaSchema })
        },
        shouldRevalidate: 'onBlur',
        defaultValue: initial,
    })

    // Recipient combo logic — initialize from initial.recipient
    const initialIsKnown = React.useMemo(
        () => RecipientOptions.some(o => o.value === initial.recipient),
        [initial.recipient],
    )
    const [recipientMode, setRecipientMode] = React.useState<'list' | 'custom'>(initialIsKnown ? 'list' : 'custom')
    const [selectedRecipient, setSelectedRecipient] = React.useState<string>(
        initialIsKnown ? initial.recipient : '',
    )
    const [customRecipient, setCustomRecipient] = React.useState<string>(initialIsKnown ? '' : initial.recipient)

    React.useEffect(() => {
        const hidden = document.getElementById(fields.recipient.id) as HTMLInputElement | null
        const val = recipientMode === 'list' ? selectedRecipient : customRecipient
        setInputValue(hidden, val || '')
    }, [recipientMode, selectedRecipient, customRecipient, fields.recipient.id])

    const recipientHelp =
        recipientMode === 'list' && selectedRecipient
            ? `${RecipientOptions.find(o => o.value === selectedRecipient)?.label ?? ''} — ${selectedRecipient}`
            : recipientMode === 'custom' && customRecipient
                ? 'Custom OID'
                : undefined

    function buildCurrentValues() {
        return {
            submissionId: submission.id,
            title: fields.title.value,
            authorType: fields.authorType.value,
            purposeOfSubmission: fields.purposeOfSubmission.value,
            recipient: (document.getElementById(fields.recipient.id) as HTMLInputElement)?.value,
            providerId: fields.providerId.value,
            claimId: fields.claimId.value,
            caseId: fields.caseId.value,
            comments: fields.comments.value,
            autoSplit: String(fields.autoSplit.value),
            sendInX12: String(fields.sendInX12.value),
            threshold: Number(fields.threshold.value),
            doc_name: fields.doc_name.value,
            doc_split_no: Number(fields.doc_split_no.value || 1),
            doc_filename: fields.doc_filename.value,
            doc_document_type: fields.doc_document_type.value,
            doc_attachment: fields.doc_attachment.value,
        }
    }
    function diffObjects(a: any, b: any) {
        const out: Record<string, { before: any; after: any }> = {}
        const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
        for (const k of keys)
            if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out[k] = { before: a?.[k], after: b?.[k] }
        return out
    }

    const [wantsUpdate, setWantsUpdate] = React.useState<'yes' | 'no'>('no')

    return (
        <InterexLayout
            user={user}
            title="Review & Update"
            subtitle="Step 2 of 3"
            currentPath={`/customer/submissions/${submission.id}/review`}
        >
            <LoadingOverlay
                show={Boolean(isUpdating)}
                title="Updating submission…"
                message="Hold tight while we push your changes to PCG."
            />

            <Drawer
                key={`drawer-review-${submission.id}`}
                isOpen
                onClose={() => navigate('/customer/submissions')}
                title={`Review Submission: ${submission.title}`}
                size="fullscreen"
            >
                <div className="space-y-8">
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                        <strong>Heads up:</strong> Review and make any final changes to the submission metadata here. After you
                        upload the file in the next step, edits to metadata are disabled.
                    </div>

                    <Form
                        method="POST"
                        {...getFormProps(form)}
                        className="space-y-8"
                        onSubmit={() => {
                            try {
                                const initialObj = JSON.parse(initialJson)
                                const current = buildCurrentValues()
                                const _changes = diffObjects(initialObj, current)
                            } catch {}
                        }}
                    >
                        <input type="hidden" name="intent" value="update-submission" />
                        <input type="hidden" name="submissionId" value={submission.id} />
                        <input type="hidden" name="_initial_json" value={initialJson} />
                        {/* hidden recipient actual field */}
                        <input {...getInputProps(fields.recipient, { type: 'hidden' })} />

                        {/* ===== Submission Details ===== */}
                        <div className="rounded-lg border border-gray-200 bg-white p-4">
                            <h3 className="text-base font-semibold text-gray-900 mb-4">Submission Details</h3>

                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Title *' }}
                                        inputProps={{ ...getInputProps(fields.title, { type: 'text' }) }}
                                        errors={fields.title.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <SelectField
                                        labelProps={{ children: 'Author Type *' }}
                                        selectProps={getSelectProps(fields.authorType)}
                                        errors={fields.authorType.errors}
                                    >
                                        {AuthorTypeEnum.options.map((a: string) => (
                                            <option key={a} value={a}>
                                                {formatEnum(a)}
                                            </option>
                                        ))}
                                    </SelectField>
                                </div>

                                <div className="md:col-span-6">
                                    <SelectField
                                        labelProps={{ children: 'Purpose *' }}
                                        selectProps={getSelectProps(fields.purposeOfSubmission)}
                                        errors={fields.purposeOfSubmission.errors}
                                    >
                                        {SubmissionPurposeValues.map((p: string) => (
                                            <option key={p} value={p}>
                                                {formatEnum(p)}
                                            </option>
                                        ))}
                                    </SelectField>
                                </div>

                                {/* Recipient combobox */}
                                <div className="md:col-span-6">
                                    <label className="block text-sm font-medium text-gray-700">Recipient *</label>
                                    <div className="mt-1 flex gap-2">
                                        <select
                                            value={recipientMode}
                                            onChange={e => setRecipientMode(e.target.value as 'list' | 'custom')}
                                            className="w-36 rounded-md border border-gray-300 bg-white py-2 px-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 shadow-sm"
                                        >
                                            <option value="list">Pick</option>
                                            <option value="custom">Custom</option>
                                        </select>

                                        {recipientMode === 'list' ? (
                                            <select
                                                value={selectedRecipient}
                                                onChange={e => setSelectedRecipient(e.target.value)}
                                                className="flex-1 rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 shadow-sm"
                                            >
                                                <option value="" disabled>
                                                    Select recipient
                                                </option>
                                                {RecipientOptions.map(opt => (
                                                    <option key={opt.value} value={opt.value}>
                                                        {opt.label}
                                                    </option>
                                                ))}
                                            </select>
                                        ) : (
                                            <input
                                                type="text"
                                                value={customRecipient}
                                                onChange={e => setCustomRecipient(e.target.value)}
                                                placeholder="Enter OID (e.g., 2.16.840...)"
                                                className="flex-1 rounded-md border border-gray-300 bg-white py-2 px-3 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 shadow-sm"
                                            />
                                        )}
                                    </div>
                                    {recipientHelp ? <p className="mt-1 text-xs text-gray-500">{recipientHelp}</p> : null}
                                    <ErrorList errors={fields.recipient.errors} id={`${fields.recipient.id}-errors`} />
                                </div>

                                <div className="md:col-span-6">
                                    <SelectField
                                        labelProps={{ children: 'NPI *' }}
                                        selectProps={getSelectProps(fields.providerId)}
                                        errors={fields.providerId.errors}
                                    >
                                        {availableNpis.map((p: Npi) => (
                                            <option key={p.id} value={p.id}>
                                                {p.npi}
                                                {p.name ? ` - ${p.name}` : ''}
                                            </option>
                                        ))}
                                    </SelectField>
                                </div>

                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Claim ID *' }}
                                        inputProps={{ ...getInputProps(fields.claimId, { type: 'text' }) }}
                                        errors={fields.claimId.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Case ID' }}
                                        inputProps={{ ...getInputProps(fields.caseId, { type: 'text' }), maxLength: 32 }}
                                        errors={fields.caseId.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <TextareaField
                                        labelProps={{ children: 'Comments' }}
                                        textareaProps={{
                                            ...getInputProps(fields.comments, { type: 'text' }),
                                            rows: 3,
                                            className: 'text-gray-900 placeholder-gray-400',
                                        }}
                                        errors={fields.comments.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <SelectField
                                        labelProps={{ children: 'Send in X12' }}
                                        selectProps={getSelectProps(fields.sendInX12)}
                                        errors={fields.sendInX12.errors}
                                    >
                                        <option value="false">False</option>
                                        <option value="true">True</option>
                                    </SelectField>
                                </div>

                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Threshold' }}
                                        inputProps={{ ...getInputProps(fields.threshold, { type: 'number' }), min: 1 }}
                                        errors={fields.threshold.errors}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* ===== Document Metadata ===== */}
                        <div className="rounded-lg border border-gray-200 bg-white p-4">
                            <h3 className="text-base font-semibold text-gray-900 mb-4">Document Metadata</h3>

                            <FileDropzone
                                label="File (metadata only in this step)"
                                accept="application/pdf"
                                initialFile={cached}
                                onPick={async f => {
                                    await setCachedFile(submission.id, f)
                                    setCached(f)
                                    setInputValue(document.getElementById(fields.doc_filename.id) as HTMLInputElement, f.name)
                                    const base = f.name.replace(/\.pdf$/i, '')
                                    const docNameEl = document.getElementById(fields.doc_name.id) as HTMLInputElement
                                    if (!docNameEl.value) setInputValue(docNameEl, base)
                                    const sizeMB = f.size / 1024 / 1024
                                    if (sizeMB >= 150) {
                                        setInputValue(document.getElementById(fields.autoSplit.id) as HTMLInputElement, 'true')
                                    }
                                }}
                                note="This does not upload the file yet. It only helps keep the metadata aligned."
                            />

                            <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-4">
                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Document Name *' }}
                                        inputProps={{ ...getInputProps(fields.doc_name, { type: 'text' }) }}
                                        errors={fields.doc_name.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Filename (.pdf) *' }}
                                        inputProps={{ ...getInputProps(fields.doc_filename, { type: 'text' }) }}
                                        errors={fields.doc_filename.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Split No' }}
                                        inputProps={{
                                            ...getInputProps(fields.doc_split_no, { type: 'number' }),
                                            min: 1,
                                            defaultValue: 1,
                                        }}
                                        errors={fields.doc_split_no.errors}
                                    />
                                </div>

                                <input type="hidden" name="doc_document_type" value="pdf" />
                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Document Type' }}
                                        inputProps={{
                                            id: fields.doc_document_type.id,
                                            type: 'text',
                                            value: 'pdf',
                                            readOnly: true,
                                        }}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <Field
                                        labelProps={{ children: 'Attachment Control Number *' }}
                                        inputProps={{ ...getInputProps(fields.doc_attachment, { type: 'text' }) }}
                                        errors={fields.doc_attachment.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <SelectField
                                        labelProps={{ children: 'Auto Split (150–300 MB)' }}
                                        selectProps={getSelectProps(fields.autoSplit)}
                                        errors={fields.autoSplit.errors}
                                    >
                                        <option value="false">False</option>
                                        <option value="true">True</option>
                                    </SelectField>
                                </div>
                            </div>
                        </div>

                        <div className="mt-1 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                            Select <strong>Yes</strong> below to show the <strong>Update Submission</strong> button, which is hidden by
                            default to prevent accidental calls to the “Update Submission” API.
                        </div>
                        <div className="pt-1">
                            <label className="block text-sm font-medium text-gray-700 mb-1">Need to update submission?</label>
                            <select
                                value={wantsUpdate}
                                onChange={e => setWantsUpdate(e.target.value as 'yes' | 'no')}
                                className="mt-1 block w-60 rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 shadow-sm"
                            >
                                <option value="no">No</option>
                                <option value="yes">Yes</option>
                            </select>
                        </div>

                        <div className="flex items-center justify-between">
                            {wantsUpdate === 'yes' ? (
                                <StatusButton
                                    type="submit"
                                    disabled={isUpdating}
                                    status={isUpdating ? 'pending' : 'idle'}
                                    className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                                >
                                    Update Submission
                                </StatusButton>
                            ) : (
                                <div className="text-xs text-gray-500">
                                    (Update button hidden — set “Need to update submission?” to <strong>Yes</strong> to show it)
                                </div>
                            )}

                            <Link
                                to={`/customer/submissions/${submission.id}/upload`}
                                className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                            >
                                Next
                            </Link>
                        </div>

                        <ErrorList
                            errors={actionData && 'result' in actionData ? (actionData as any).result?.error?.formErrors : []}
                            id={form.errorId}
                        />
                    </Form>

                    <SubmissionActivityLog events={submission.events ?? []} />
                </div>
            </Drawer>
        </InterexLayout>
    )
}
