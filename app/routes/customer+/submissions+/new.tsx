import * as React from 'react'
import { getFormProps, getInputProps, getSelectProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
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
import { Field, SelectField, TextareaField, ErrorList } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import {
    SubmissionPurposeValues,
    SubmissionPurposeEnum,
    AuthorTypeEnum,
    formatEnum,
    RecipientOptions,
} from '#app/domain/submission-enums.ts'
import { buildCreateSubmissionPayload, pcgCreateSubmission } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { FileDropzone } from '#app/components/file-dropzone.tsx'
import { SubmissionPurpose as PrismaSubmissionPurpose } from '@prisma/client'
import { draftKey, getCachedFile, setCachedFile } from '#app/utils/file-cache.ts'

type Npi = { id: string; npi: string; name: string | null }

const DEFAULT_ACN_HINT = 'Please specify attachment control number'

// ---------- Schema (base form fields) ----------
const CreateSubmissionSchema = z.object({
    intent: z.literal('create'),
    title: z.string().min(1, 'Title is required'),
    authorType: AuthorTypeEnum,
    purposeOfSubmission: SubmissionPurposeEnum,
    recipient: z.string().min(1, 'Recipient is required'),
    providerId: z.string().min(1, 'NPI selection is required'),
    claimId: z.string().min(1, 'Claim ID is required'),
    caseId: z.string().max(32).optional(),
    comments: z.string().optional(),

    splitKind: z.enum(['manual', 'auto'], { required_error: 'Split kind is required' }),
    docCount: z.preprocess(v => (v === '' ? undefined : v), z.coerce.number().int()).optional(),

    autoSplit: z.enum(['true', 'false']).transform(v => v === 'true'),
    sendInX12: z.enum(['true', 'false']).transform(v => v === 'true'),
    threshold: z.coerce.number().int().min(1).default(100),

    // carries the per-tab nonce so we can move cached files once we have a submissionId
    draftNonce: z.string().min(1, 'Missing draft nonce'),
})

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

    const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(r => r.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin') || isCustomerAdmin

    if (!user.customerId && !isSystemAdmin) {
        throw new Response('User must be associated with a customer', { status: 400 })
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

    return data({ user, availableNpis })
}

// Helper to pull N document blocks from formData
function collectDocumentsFromForm(formData: FormData, kind: 'manual' | 'auto', docCount?: number) {
    const errors: string[] = []
    const count = kind === 'manual' ? Number(docCount) : 1
    if (kind === 'manual') {
        if (![1, 3, 4, 5].includes(count)) {
            errors.push('Number of documents must be 1, 3, 4, or 5.')
        }
    }

    const documents: Array<{
        name: string
        filename: string
        attachmentControlNum: string
        split_no: number
        document_type: 'pdf'
    }> = []

    for (let i = 1; i <= (kind === 'manual' ? count : 1); i++) {
        const name = String(formData.get(`doc_name_${i}`) || '').trim()
        const filename = String(formData.get(`doc_filename_${i}`) || '').trim()
        const attachment = String(formData.get(`doc_attachment_${i}`) || '').trim()

        if (!name) errors.push(`Document ${i}: name is required`)
        if (!filename) errors.push(`Document ${i}: filename is required`)
        if (filename && !/\.pdf$/i.test(filename)) errors.push(`Document ${i}: filename must end with .pdf`)
        if (!attachment) errors.push(`Document ${i}: Attachment Control Number is required`)

        documents.push({
            name,
            filename,
            attachmentControlNum: attachment,
            split_no: i,
            document_type: 'pdf',
        })
    }

    return { documents, errors }
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

    const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(r => r.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin') || isCustomerAdmin

    const formData = await request.formData()
    const parsed = parseWithZod(formData, { schema: CreateSubmissionSchema })

    if (parsed.status !== 'success') {
        return Response.json({ result: parsed.reply() }, { status: parsed.status === 'error' ? 400 : 200 })
    }

    const {
        title,
        authorType,
        purposeOfSubmission,
        recipient,
        providerId,
        claimId,
        caseId,
        comments,
        splitKind,
        docCount,
        autoSplit,
        sendInX12,
        threshold,
        draftNonce,
    } = parsed.value as any

    if (splitKind === 'manual' && ![1, 3, 4, 5].includes(Number(docCount))) {
        return data(
            { result: parsed.reply({ formErrors: ['Please choose the number of documents (1, 3, 4, or 5).'] }) },
            { status: 400 },
        )
    }

    const { documents, errors } = collectDocumentsFromForm(formData, splitKind, docCount)
    if (errors.length) {
        return data({ result: parsed.reply({ formErrors: errors }) }, { status: 400 })
    }

    const provider = await prisma.provider.findUnique({
        where: { id: providerId },
        include: { providerGroup: true },
    })
    if (!provider || (provider.customerId !== user.customerId && !isSystemAdmin)) {
        return data({ result: parsed.reply({ formErrors: ['Invalid provider selection'] }) }, { status: 400 })
    }
    if (!isSystemAdmin) {
        if (isProviderGroupAdmin && user.providerGroupId) {
            if (provider.providerGroupId !== user.providerGroupId) {
                return data(
                    { result: parsed.reply({ formErrors: ['You can only create submissions for providers in your group'] }) },
                    { status: 400 },
                )
            }
        } else if (!isCustomerAdmin) {
            const hasAccess = user.userNpis.some(un => un.providerId === providerId)
            if (!hasAccess) {
                return data(
                    { result: parsed.reply({ formErrors: ['You can only create submissions for your assigned NPIs'] }) },
                    { status: 400 },
                )
            }
        }
    }

    const newSubmission = await prisma.submission.create({
        data: {
            title,
            authorType,
            purposeOfSubmission: purposeOfSubmission as PrismaSubmissionPurpose,
            recipient,
            claimId: claimId || null,
            caseId: caseId || null,
            comments: comments || null,
            autoSplit,
            sendInX12,
            threshold,
            creatorId: userId,
            providerId,
            customerId: isSystemAdmin ? provider.customerId : user.customerId!,
            status: 'DRAFT',
        },
    })

    const pcgPayload = buildCreateSubmissionPayload({
        purposeOfSubmission,
        author_npi: provider.npi,
        author_type: authorType,
        name: title,
        esMD_claim_id: claimId ?? '',
        esmd_case_id: caseId ?? '',
        comments: comments ?? '',
        intended_recepient: recipient,
        auto_split: autoSplit,
        bSendinX12: sendInX12,
        threshold,
        document_set: documents.map(d => ({
            name: d.name,
            split_no: d.split_no,
            filename: d.filename,
            document_type: d.document_type,
            attachmentControlNum: d.attachmentControlNum,
        })),
    })

    await prisma.submissionEvent.create({
        data: {
            submissionId: newSubmission.id,
            kind: 'DRAFT_CREATED',
            message: 'Local draft created (payload audit)',
            payload: pcgPayload,
        },
    })

    try {
        const pcgResp = await pcgCreateSubmission(pcgPayload)
        if (!pcgResp?.submission_id) throw new Error('PCG did not return a submission_id')

        await prisma.submission.update({
            where: { id: newSubmission.id },
            data: { pcgSubmissionId: pcgResp.submission_id, responseMessage: 'Draft', status: 'DRAFT' },
        })

        await prisma.submissionEvent.create({
            data: {
                submissionId: newSubmission.id,
                kind: 'PCG_CREATE_SUCCESS',
                message: `PCG submission created (id ${pcgResp.submission_id})`,
                payload: pcgResp,
            },
        })

        return await redirectWithToast(`/customer/submissions/${newSubmission.id}/review?draft=${encodeURIComponent(draftNonce)}`, {
            type: 'success',
            title: 'Submission Created',
            description: 'Metadata saved. Review your data next.',
        })
    } catch (e: any) {
        await prisma.submission.update({
            where: { id: newSubmission.id },
            data: { status: 'ERROR', errorDescription: e?.message?.toString?.() ?? 'Create failed' },
        })
        await prisma.submissionEvent.create({
            data: {
                submissionId: newSubmission.id,
                kind: 'PCG_CREATE_ERROR',
                message: e?.message?.toString?.() ?? 'Create failed',
            },
        })

        return await redirectWithToast(`/customer/submissions`, {
            type: 'error',
            title: 'Create Failed',
            description: e?.message?.toString?.() ?? 'Unable to create submission',
        })
    }
}

export default function NewSubmission() {
    const { user, availableNpis } = useLoaderData<typeof loader>()
    const actionData = useActionData<typeof action>()
    const nav = useNavigation()
    const navigate = useNavigate()
    const isSubmitting = nav.formData?.get('intent') === 'create'

    const [form, fields] = useForm({
        id: 'create-submission',
        constraint: getZodConstraint(CreateSubmissionSchema),
        onValidate({ formData }) {
            return parseWithZod(formData, { schema: CreateSubmissionSchema })
        },
        shouldRevalidate: 'onBlur',
    })

    const [draftNonce] = React.useState(() => crypto.randomUUID())

    // Recipient combo
    const [recipientMode, setRecipientMode] = React.useState<'list' | 'custom'>('list')
    const [selectedRecipient, setSelectedRecipient] = React.useState<string>('')
    const [customRecipient, setCustomRecipient] = React.useState<string>('')

    React.useEffect(() => {
        const hidId = fields.recipient?.id
        if (!hidId) return
        const hidden = document.getElementById(hidId) as HTMLInputElement | null
        const val = recipientMode === 'list' ? selectedRecipient : customRecipient
        if (hidden) hidden.value = val || ''
    }, [recipientMode, selectedRecipient, customRecipient, fields.recipient?.id])

    const recipientHelp =
        recipientMode === 'list' && selectedRecipient
            ? `${RecipientOptions.find(o => o.value === selectedRecipient)?.label ?? ''} — ${selectedRecipient}`
            : recipientMode === 'custom' && customRecipient
                ? 'Custom OID'
                : undefined

    // Split kind -> drives autoSplit and document blocks
    const [splitKind, setSplitKind] = React.useState<'' | 'manual' | 'auto'>('')
    const [docCount, setDocCount] = React.useState<number | ''>('')

    React.useEffect(() => {
        const hidId = fields.autoSplit?.id
        if (!hidId) return
        const hidden = document.getElementById(hidId) as HTMLInputElement | null
        if (!hidden) return
        if (splitKind === 'manual') hidden.value = 'false'
        else if (splitKind === 'auto') hidden.value = 'true'
        else hidden.value = ''
    }, [splitKind, fields.autoSplit?.id])

    // ---- Document UX + caching ----
    const [dropErrors, setDropErrors] = React.useState<Record<number, string>>({})
    const [docPicked, setDocPicked] = React.useState<Record<number, boolean>>({})
    const [docFilled, setDocFilled] = React.useState<Record<number, boolean>>({})
    const [docSizes, setDocSizes] = React.useState<Record<number, number>>({})
    const [dzReset, setDzReset] = React.useState<Record<number, number>>({})
    const [initialFiles, setInitialFiles] = React.useState<Record<number, File | null>>({})

    // New: document metadata becomes controlled state
    type DocMeta = { name: string; filename: string; attachmentControlNum: string }
    const [docMeta, setDocMeta] = React.useState<Record<number, DocMeta>>({})

    const totalSizeMB = React.useMemo(
        () => Object.values(docSizes).reduce((a, b) => a + b, 0) / (1024 * 1024),
        [docSizes],
    )

    // NOTE: treat the ACN hint as empty for "filled" logic
    function computeFilled(m: DocMeta) {
        return Boolean(
            m.name.trim() &&
            /\.pdf$/i.test(m.filename.trim()) &&
            m.attachmentControlNum.trim() &&
            m.attachmentControlNum.trim() !== DEFAULT_ACN_HINT
        )
    }

    function updateDocMeta(i: number, patch: Partial<DocMeta>, recompute = true) {
        setDocMeta(prev => {
            const base: DocMeta = prev[i] ?? { name: '', filename: '', attachmentControlNum: DEFAULT_ACN_HINT }
            const next = { ...base, ...patch }
            const merged = { ...prev, [i]: next }
            if (recompute) {
                const ok = computeFilled(next)
                setDocFilled(p => ({ ...p, [i]: ok }))
            }
            return merged
        })
    }

    function titleCaseFrom(filename: string) {
        const base = filename.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim()
        return base.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1))
    }

    async function handlePick(idx: number, file: File) {
        const BYTES_PER_MB = 1024 * 1024
        const mb = file.size / BYTES_PER_MB
        const isPdf = /\.pdf$/i.test(file.name)
        const existingTotalBytes = Object.entries(docSizes).reduce(
            (sum, [k, v]) => sum + (Number(k) === idx ? 0 : v),
            0,
        )
        const wouldBeTotalMB = (existingTotalBytes + file.size) / BYTES_PER_MB

        let err = ''
        if (!isPdf) err = 'PDF only'
        else if (mb > 150) err = `This file is ${mb.toFixed(1)} MB — the per-file limit is 150 MB.`
        else if (wouldBeTotalMB > 300) err = `Total selected would be ${wouldBeTotalMB.toFixed(1)} MB — the submission limit is 300 MB.`
        if (err) {
            window.alert(err)
            setDropErrors(prev => ({ ...prev, [idx]: err }))
            setDocPicked(prev => ({ ...prev, [idx]: false }))
            setDocSizes(prev => { const next = { ...prev }; delete next[idx]; return next })
            setDzReset(prev => ({ ...prev, [idx]: (prev[idx] ?? 0) + 1 }))
            return
        }

        // Update UI first (non-blocking)
        console.log('picked file', { idx, name: file.name, size: file.size })
        setDropErrors(prev => ({ ...prev, [idx]: '' }))
        setDocPicked(prev => ({ ...prev, [idx]: true }))
        setDocSizes(prev => ({ ...prev, [idx]: file.size }))

        const current = docMeta[idx] ?? { name: '', filename: '', attachmentControlNum: DEFAULT_ACN_HINT }
        updateDocMeta(
            idx,
            {
                filename: file.name,
                name: current.name ? current.name : titleCaseFrom(file.name),
            },
            true,
        )

        // Best-effort cache write AFTER UI updates
        try {
            await setCachedFile(draftKey(draftNonce, idx), file)
        } catch (e) {
            console.warn('cache write failed (non-blocking)', e)
        }
    }

    // Try pre-fill from cache (user might navigate back)
    React.useEffect(() => {
        void (async () => {
            const count = splitKind === 'manual' ? Number(docCount || 0) : splitKind === 'auto' ? 1 : 0
            if (!count) return
            const nextFiles: Record<number, File | null> = {}
            const sizes: Record<number, number> = {}
            const metaUpdates: Record<number, DocMeta> = {}
            for (let i = 1; i <= count; i++) {
                const f = await getCachedFile(draftKey(draftNonce, i))
                nextFiles[i] = f ?? null
                const base = docMeta[i] ?? { name: '', filename: '', attachmentControlNum: DEFAULT_ACN_HINT }
                if (f) {
                    sizes[i] = f.size
                    metaUpdates[i] = {
                        name: base.name || titleCaseFrom(f.name),
                        filename: base.filename || f.name,
                        attachmentControlNum: base.attachmentControlNum,
                    }
                    setDocPicked(prev => ({ ...prev, [i]: true }))
                } else {
                    metaUpdates[i] = base
                }
            }
            setInitialFiles(nextFiles)
            setDocSizes(sizes)
            setDocMeta(prev => {
                const merged: Record<number, DocMeta> = { ...prev, ...metaUpdates }
                // recompute filled flags
                const nextFilled: Record<number, boolean> = {}
                Object.entries(merged).forEach(([k, v]) => {
                    nextFilled[Number(k)] = computeFilled(v)
                })
                setDocFilled(nextFilled)
                return merged
            })
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [splitKind, docCount, draftNonce])

    // Reset state when split kind / doc count changes
    React.useEffect(() => {
        setDocPicked({})
        setDocFilled({})
        setDropErrors({})
        setDocSizes({})
        setDzReset({})
        setInitialFiles({})
        // prepare default docMeta slots with ACN hint so UI mirrors old behavior
        if (splitKind) {
            const count = splitKind === 'manual' ? Number(docCount || 0) : 1
            const init: Record<number, DocMeta> = {}
            for (let i = 1; i <= (count || 0); i++) {
                init[i] = { name: '', filename: '', attachmentControlNum: DEFAULT_ACN_HINT }
            }
            setDocMeta(init)
        } else {
            setDocMeta({})
        }
    }, [splitKind, docCount])

    return (
        <InterexLayout user={user} title="Create Submission" subtitle="Step 1 of 3" currentPath="/customer/submissions/new">
            <LoadingOverlay
                show={Boolean(isSubmitting)}
                title="Creating submission…"
                message="Please don't refresh or close this tab while we create the draft in PCG."
            />

            <Drawer key="drawer-new" isOpen onClose={() => navigate('/customer/submissions')} title="Create New Submission" size="fullscreen">
                <Form method="POST" {...getFormProps(form)} className="space-y-8">
                    <input type="hidden" name="intent" value="create" />
                    <input type="hidden" name="draftNonce" value={draftNonce} />
                    <input {...getInputProps(fields.recipient, { type: 'hidden' })} />
                    <input {...getInputProps(fields.autoSplit, { type: 'hidden' })} />

                    {/* ===== Submission Details ===== */}
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                        <h3 className="text-base font-semibold text-gray-900 mb-4">Submission Details</h3>
                        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                            <div className="md:col-span-6">
                                <Field
                                    labelProps={{ children: 'Title *' }}
                                    inputProps={{ ...getInputProps(fields.title, { type: 'text' }), placeholder: 'Enter submission title' }}
                                    errors={fields.title?.errors}
                                />
                            </div>

                            <div className="md:col-span-6">
                                <SelectField labelProps={{ children: 'Author Type *' }} selectProps={getSelectProps(fields.authorType)} errors={fields.authorType?.errors}>
                                    <option value="">Select author type</option>
                                    {AuthorTypeEnum.options.map(a => (
                                        <option key={a} value={a}>{formatEnum(a)}</option>
                                    ))}
                                </SelectField>
                            </div>

                            <div className="md:col-span-6">
                                <SelectField
                                    labelProps={{ children: 'Purpose of Submission *' }}
                                    selectProps={getSelectProps(fields.purposeOfSubmission)}
                                    errors={fields.purposeOfSubmission?.errors}
                                >
                                    <option value="">Select purpose</option>
                                    {SubmissionPurposeValues.map(p => (
                                        <option key={p} value={p}>{formatEnum(p)}</option>
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
                                <ErrorList errors={fields.recipient?.errors} id={`${fields.recipient?.id ?? 'recipient'}-errors`} />
                            </div>

                            <div className="md:col-span-6">
                                <SelectField labelProps={{ children: 'NPI *' }} selectProps={getSelectProps(fields.providerId)} errors={fields.providerId?.errors}>
                                    <option value="">Select NPI</option>
                                    {availableNpis.map(p => (
                                        <option key={p.id} value={p.id}>
                                            {p.npi}
                                            {p.name ? ` - ${p.name}` : ''}
                                        </option>
                                    ))}
                                </SelectField>
                            </div>

                            <div className="md:col-span-6">
                                <Field labelProps={{ children: 'Claim ID *' }} inputProps={{ ...getInputProps(fields.claimId, { type: 'text' }) }} errors={fields.claimId?.errors} />
                            </div>

                            <div className="md:col-span-6">
                                <Field
                                    labelProps={{ children: 'Case ID' }}
                                    inputProps={{ ...getInputProps(fields.caseId, { type: 'text' }), placeholder: 'Up to 32 chars', maxLength: 32 }}
                                    errors={fields.caseId?.errors}
                                />
                            </div>

                            <div className="md:col-span-6">
                                <TextareaField
                                    labelProps={{ children: 'Comments' }}
                                    textareaProps={{
                                        ...getInputProps(fields.comments, { type: 'text' }),
                                        rows: 3,
                                        placeholder: 'Notes (optional)',
                                        className: 'text-gray-900 placeholder-gray-400',
                                    }}
                                    errors={fields.comments?.errors}
                                />
                            </div>

                            <div className="md:col-span-6">
                                <SelectField labelProps={{ children: 'Send in X12' }} selectProps={getSelectProps(fields.sendInX12)} errors={fields.sendInX12?.errors}>
                                    <option value="false">False</option>
                                    <option value="true">True</option>
                                </SelectField>
                            </div>

                            <div className="md:col-span-6">
                                <Field
                                    labelProps={{ children: 'Threshold' }}
                                    inputProps={{ ...getInputProps(fields.threshold, { type: 'number' }), min: 1, placeholder: '100' }}
                                    errors={fields.threshold?.errors}
                                />
                            </div>
                        </div>
                    </div>

                    {/* ===== Split Settings (highlight) ===== */}
                    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
                        <h4 className="text-sm font-semibold text-indigo-900 mb-3">Split Settings</h4>
                        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                            <div className="md:col-span-6">
                                <label className="block text-sm font-medium text-gray-700">Split kind *</label>
                                <select
                                    name="splitKind"
                                    value={splitKind}
                                    onChange={e => {
                                        const v = e.target.value as 'manual' | 'auto' | ''
                                        setSplitKind(v)
                                        if (v === 'auto') setDocCount('')
                                        setDocPicked({})
                                        setDocFilled({})
                                        setDropErrors({})
                                        setDocSizes({})
                                        setDzReset({})
                                    }}
                                    className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm"
                                    required
                                >
                                    <option value="">Select</option>
                                    <option value="manual">Manual</option>
                                    <option value="auto">Auto</option>
                                </select>
                                <p className="mt-1 text-xs text-gray-500">
                                    This only affects how you enter document metadata. We’ll set <code>auto_split</code> accordingly.
                                </p>
                            </div>

                            <div className="md:col-span-6">
                                <label className="block text-sm font-medium text-gray-700">auto_split (derived)</label>
                                <input
                                    type="text"
                                    readOnly
                                    value={splitKind === '' ? '' : splitKind === 'auto' ? 'true' : 'false'}
                                    placeholder="—"
                                    className="mt-1 block w-full rounded-md border border-gray-200 bg-white py-2 px-3 text-sm"
                                />
                            </div>

                            {splitKind === 'manual' ? (
                                <div className="md:col-span-6">
                                    <label className="block text-sm font-medium text-gray-700">Number of documents *</label>
                                    <select
                                        name="docCount"
                                        value={docCount}
                                        onChange={e => {
                                            setDocCount(e.target.value ? Number(e.target.value) : '')
                                            setDocPicked({})
                                            setDocFilled({})
                                            setDropErrors({})
                                            setDocSizes({})
                                            setDzReset({})
                                        }}
                                        className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm"
                                        required
                                    >
                                        <option value="">Select</option>
                                        <option value={1}>1</option>
                                        <option value={3}>3</option>
                                        <option value={4}>4</option>
                                        <option value={5}>5</option>
                                    </select>
                                    <p className="mt-1 text-xs text-gray-500">Each file will be uploaded separately in Step 3.</p>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    {/* ===== Document Metadata ===== */}
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                        <div className="flex items-center justify-between mb-2">
                            <h3 className="text-base font-semibold text-gray-900">Document Metadata</h3>
                            <div className="flex items-center gap-2 text-xs">
                <span className="inline-block rounded px-2 py-0.5 ring-1 ring-emerald-300 bg-emerald-50 text-emerald-700">
                  Total: {totalSizeMB.toFixed(1)} / 300 MB
                </span>
                            </div>
                        </div>

                        {splitKind === '' ? (
                            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                                Choose <strong>Split kind</strong> to begin entering document metadata.
                            </div>
                        ) : (
                            <>
                                {Array.from({ length: splitKind === 'manual' ? Number(docCount || 0) : 1 }).map((_, idx) => {
                                    const i = idx + 1
                                    const ok = Boolean(docPicked[i] && docFilled[i] && !dropErrors[i])
                                    const borderColor = ok ? 'border-emerald-500' : 'border-rose-400'
                                    const meta = docMeta[i] ?? { name: '', filename: '', attachmentControlNum: DEFAULT_ACN_HINT }
                                    return (
                                        <div key={i} className={`mb-4 rounded-md border ${borderColor} p-3 transition-colors`}>
                                            <div className="mb-2 flex items-center justify-between">
                                                <div className="text-sm font-medium text-gray-700">Document #{i}</div>
                                                <div
                                                    className={`text-xs rounded px-2 py-0.5 ring-1 ${
                                                        ok ? 'bg-emerald-50 text-emerald-700 ring-emerald-300' : 'bg-rose-50 text-rose-700 ring-rose-300'
                                                    }`}
                                                >
                                                    {ok ? 'Filled & file added' : 'Not updated / no file'}
                                                </div>
                                            </div>

                                            <FileDropzone
                                                key={`dz-${i}-${dzReset[i] ?? 0}`}
                                                label="Attach PDF (optional)"
                                                note="Pre-check size (≤150 MB) and auto-fill filename/name. Actual upload happens in Step 3."
                                                onPick={file => handlePick(i, file)}
                                                initialFile={initialFiles[i] ?? null}
                                            />
                                            {dropErrors[i] ? (
                                                <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                                                    {dropErrors[i]}
                                                </div>
                                            ) : null}

                                            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 mt-3">
                                                <div className="md:col-span-3">
                                                    <label className="block text-sm text-gray-700">split_no</label>
                                                    <input
                                                        type="text"
                                                        readOnly
                                                        value={i}
                                                        className="mt-1 block w-full rounded-md border border-gray-200 bg-gray-50 py-2 px-3 text-sm"
                                                    />
                                                </div>

                                                <div className="md:col-span-9" />

                                                <div className="md:col-span-6">
                                                    <label className="block text-sm text-gray-700">Document Name *</label>
                                                    <input
                                                        name={`doc_name_${i}`}
                                                        type="text"
                                                        value={meta.name}
                                                        onChange={e => updateDocMeta(i, { name: e.currentTarget.value })}
                                                        className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 px-3 text-sm"
                                                        placeholder="e.g., Progress Notes"
                                                    />
                                                </div>

                                                <div className="md:col-span-6">
                                                    <label className="block text-sm text-gray-700">Filename (.pdf) *</label>
                                                    <input
                                                        name={`doc_filename_${i}`}
                                                        type="text"
                                                        value={meta.filename}
                                                        onChange={e => updateDocMeta(i, { filename: e.currentTarget.value })}
                                                        className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 px-3 text-sm"
                                                        placeholder="MyDocument.pdf"
                                                    />
                                                </div>

                                                <div className="md:col-span-6">
                                                    <label className="block text-sm text-gray-700">Attachment Control Number *</label>
                                                    <input
                                                        name={`doc_attachment_${i}`}
                                                        type="text"
                                                        value={meta.attachmentControlNum}
                                                        onChange={e => updateDocMeta(i, { attachmentControlNum: e.currentTarget.value })}
                                                        className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 px-3 text-sm"
                                                        placeholder="ACN"
                                                    />
                                                </div>

                                                <div className="md:col-span-6">
                                                    <label className="block text-sm text-gray-700">Document Type</label>
                                                    <input
                                                        type="text"
                                                        readOnly
                                                        value="pdf"
                                                        className="mt-1 block w-full rounded-md border border-gray-200 bg-gray-50 py-2 px-3 text-sm"
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })}
                                {splitKind === 'manual' && !docCount ? (
                                    <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
                                        Select <strong>Number of documents</strong> to show blocks.
                                    </div>
                                ) : null}
                            </>
                        )}
                    </div>

                    <div className="flex items-center justify-between">
                        <Link
                            to="/customer/submissions"
                            className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                        >
                            Cancel
                        </Link>

                        <StatusButton
                            type="submit"
                            disabled={isSubmitting}
                            status={isSubmitting ? 'pending' : 'idle'}
                            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                        >
                            Next
                        </StatusButton>
                    </div>

                    <ErrorList
                        errors={actionData && 'result' in actionData ? (actionData as any).result?.error?.formErrors : []}
                        id={form.errorId}
                    />
                </Form>
            </Drawer>
        </InterexLayout>
    )
}
