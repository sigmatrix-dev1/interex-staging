// app/routes/customer+/submissions.new.tsx

/**
 * Step 1 of 3 — Create Submission
 * --------------------------------
 * This route lets a user compose submission metadata and plan documents.
 * - Validates inputs with Zod + Conform
 * - Enforces RBAC (system/customer/provider-group/assigned NPI)
 * - Creates/updates a local Submission
 * - Calls PCG to create its remote submission counterpart
 * - Immediately snapshots PCG status back into our DB for accuracy
 * - Caches picked files (by draft nonce) so user can continue later
 *
 * On success we redirect to Step 2 (review) with the draft nonce in the URL
 * so cached files can be moved from draft cache → submission cache.
 */

import { getFormProps, getInputProps, getSelectProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { type SubmissionPurpose as PrismaSubmissionPurpose } from '@prisma/client'
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

/* =========================
   UI Components & Utilities
   ========================= */
import { FileDropzone } from '#app/components/file-dropzone.tsx'
import { Field, SelectField, TextareaField, ErrorList } from '#app/components/forms.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import {
    SubmissionPurposeValues,
    SubmissionPurposeEnum,
    AuthorTypeEnum,
    formatEnum,
    type SubmissionPurpose,
    type RecipientCategory,
    RecipientCategories,
    categoriesForPurpose,
    recipientsFor,
    recipientHelperLabel,
} from '#app/domain/submission-enums.ts'
import { buildCreateSubmissionPayload, pcgCreateSubmission, pcgGetStatus } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { draftKey, getCachedFile, setCachedFile } from '#app/utils/file-cache.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'

/* ===============
   Types & Config
   =============== */
type Npi = { id: string; npi: string; name: string | null }
const DEFAULT_ACN_HINT = 'Please specify attachment control number'

/* ==========================
   Schema (base form fields)
   ========================== */
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

    // Split settings (drive UI and the derived autoSplit value)
    splitKind: z.enum(['manual', 'auto'], { required_error: 'Split kind is required' }),
    docCount: z.preprocess(v => (v === '' ? undefined : v), z.coerce.number().int()).optional(),

    // Derived flags (submitted as strings from hidden inputs / selects)
    autoSplit: z.enum(['true', 'false']).transform(v => v === 'true'),
    sendInX12: z.enum(['true', 'false']).transform(v => v === 'true'),
    threshold: z.coerce.number().int().min(1).default(100),

    // Per-tab nonce for caching files before a submissionId exists
    draftNonce: z.string().min(1, 'Missing draft nonce'),

    // Only present when retrying a previously failed submission
    retrySubmissionId: z.string().optional(),
})

/* ==========================
   Loader — Prefill & Access
   ==========================
   - Authenticates user
   - Computes available NPIs by role
   - If retry, pulls last meta/documents to prefill the form
*/
export async function loader({ request }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const url = new URL(request.url)
    const retryId = url.searchParams.get('retry') || undefined

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

    // Role-aware NPI choices (System → all, Customer/Group → scoped, Member → assigned)
    const availableNpis: Npi[] = isSystemAdmin
        ? await prisma.provider.findMany({
            where: { active: true },
            select: { id: true, npi: true, name: true },
        })
        : isCustomerAdmin && user.customerId
            ? await prisma.provider.findMany({
                where: { customerId: user.customerId, active: true },
                select: { id: true, npi: true, name: true },
            })
            : isProviderGroupAdmin && user.providerGroupId && user.customerId
                ? await prisma.provider.findMany({
                    where: { customerId: user.customerId, providerGroupId: user.providerGroupId, active: true },
                    select: { id: true, npi: true, name: true },
                })
                : user.userNpis
                    .filter(un => un.provider?.active)
                    .map(un => ({ id: un.provider.id, npi: un.provider.npi, name: un.provider.name }))

    // ---------- Retry prefill support ----------
    let retryInitial:
        | (Partial<Record<string, any>> & { retrySubmissionId: string; docCount?: number })
        | null = null
    let retryInitialDocs: Array<{ name: string; filename: string; attachmentControlNum: string }> = []

    if (retryId) {
        const submission = await prisma.submission.findFirst({
            where: { id: retryId },
            include: {
                provider: { select: { id: true, npi: true, name: true, customerId: true } },
                events: {
                    select: { id: true, kind: true, payload: true, createdAt: true },
                    orderBy: { createdAt: 'desc' },
                    take: 50,
                },
            },
        })

        if (submission) {
            // Get initial meta snapshot from the last DRAFT_CREATED or META_UPDATED
            const metaEvent =
                submission.events.find(e => e.kind === 'DRAFT_CREATED') ??
                submission.events.find(e => e.kind === 'META_UPDATED')
            const latestMeta = (metaEvent?.payload as any) ?? {}
            const docSet = Array.isArray(latestMeta?.document_set) ? latestMeta.document_set : []

            retryInitial = {
                retrySubmissionId: submission.id,
                title: latestMeta?.name ?? submission.title ?? '',
                authorType:
                    latestMeta?.author_type ??
                    (submission.authorType?.toLowerCase() === 'institutional' ? 'institutional' : 'individual'),
                purposeOfSubmission: latestMeta?.purposeOfSubmission ?? submission.purposeOfSubmission ?? '',
                recipient: latestMeta?.intended_recepient ?? submission.recipient ?? '',
                providerId: submission.provider?.id ?? '',
                claimId: latestMeta?.esMD_claim_id ?? submission.claimId ?? '',
                caseId: latestMeta?.esmd_case_id ?? submission.caseId ?? '',
                comments: latestMeta?.comments ?? submission.comments ?? '',
                splitKind: (latestMeta?.auto_split ?? submission.autoSplit) ? 'auto' : 'manual',
                autoSplit: String(Boolean(latestMeta?.auto_split ?? submission.autoSplit ?? false)),
                sendInX12: String(Boolean(latestMeta?.bSendinX12 ?? submission.sendInX12 ?? false)),
                threshold: Number(latestMeta?.threshold ?? submission.threshold ?? 100),
                docCount: docSet.length || undefined,
            }

            retryInitialDocs = docSet.map((d: any) => ({
                name: d.name || '',
                filename: d.filename || '',
                attachmentControlNum: d.attachmentControlNum || '',
            }))
        }
    }

    return data({ user, availableNpis, retryInitial, retryInitialDocs })
}

/* ==========================================
   Helper — Pull N document blocks from form
   ==========================================
   Validates document sub-fields and shapes them for PCG payload.
*/
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

/* =======================
   PCG snapshot helpers
   =======================
   After creating on PCG we immediately fetch status and update our DB.
   This keeps local rows in-sync with authoritative PCG state.
*/

/** Normalize OID from PCG (may come as 'urn:oid:<oid>' or plain). */
function normalizeOid(oid?: string | null) {
    if (!oid) return undefined
    const s = String(oid)
    return s.startsWith('urn:oid:') ? s.slice('urn:oid:'.length) : s
}

/** Map PCG purpose code to our Prisma enum (fallback to previous local value if unknown). */
function mapPcgPurposeCodeToLocalEnum(code?: string | null): PrismaSubmissionPurpose | undefined {
    const c = (code ?? '').trim()
    if (!c) return undefined
    switch (c) {
        case '1':
            return 'ADR' as PrismaSubmissionPurpose
        case '7':
            return 'PWK_CLAIM_DOCUMENTATION' as PrismaSubmissionPurpose
        case '9':
            return 'FIRST_APPEAL' as PrismaSubmissionPurpose
        case '9.1':
            return 'SECOND_APPEAL' as PrismaSubmissionPurpose
        default:
            return undefined
    }
}

/**
 * Fetch PCG status and write a PCG_STATUS event + overwrite local DB fields.
 * Best-effort: failure here should not block user flow.
 */
async function persistRemoteSnapshot(submissionId: string, pcgId: string) {
    const statusResp = await pcgGetStatus(pcgId)

    // Always audit the raw payload we got from PCG
    await prisma.submissionEvent.create({
        data: {
            submissionId,
            kind: 'PCG_STATUS',
            message: statusResp.stage ?? 'Status retrieved',
            payload: statusResp,
        },
    })

    // PCG may return one of multiple identifiers; normalize to a single transactionId
    const rawTxnList = (statusResp as any)?.transactionIdList || (statusResp as any)?.uniqueIdList || ''
    const normalizedTxnList = typeof rawTxnList === 'string' ? rawTxnList.trim() : ''
    const txn = statusResp.esmdTransactionId ?? (normalizedTxnList || null)

    // Update local submission with the authoritative snapshot
    const updateData: any = {
        responseMessage: statusResp.stage ?? undefined,
        transactionId: txn ?? undefined,
        pcgSubmissionId: pcgId,
        title: statusResp.title ?? undefined,
        claimId: statusResp.esmdClaimId ?? undefined,
        caseId: statusResp.esmdCaseId ?? undefined,
        authorType: statusResp.authorType ?? undefined,
        autoSplit: typeof statusResp.autoSplit === 'boolean' ? statusResp.autoSplit : undefined,
        comments: statusResp.comments ?? undefined,
        recipient: normalizeOid(statusResp.intendedRecipient?.oid) ?? undefined,
    }

    const mappedPurpose = mapPcgPurposeCodeToLocalEnum(statusResp.purposeOfSubmission?.contentType)
    if (mappedPurpose) updateData.purposeOfSubmission = mappedPurpose

    // Optional combined error surface (convenience for operators)
    const allErrors = [...(statusResp.errorList ?? []), ...(statusResp.errors ?? [])]
    if (allErrors.length) {
        updateData.errorDescription = allErrors
            .map((e: any) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)))
            .join('; ')
    }

    await prisma.submission.update({ where: { id: submissionId }, data: updateData })
}

/* ==========================
   Action — Create submission
   ==========================
   Validates, enforces RBAC, creates/updates local row,
   calls PCG, snapshots PCG status, then redirects to Step 2.
*/
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
        retrySubmissionId,
    } = parsed.value as any

    // Split validation
    if (splitKind === 'manual' && ![1, 3, 4, 5].includes(Number(docCount))) {
        return data(
            { result: parsed.reply({ formErrors: ['Please choose the number of documents (1, 3, 4, or 5).'] }) },
            { status: 400 },
        )
    }

    // Document blocks
    const { documents, errors } = collectDocumentsFromForm(formData, splitKind, docCount)
    if (errors.length) {
        return data({ result: parsed.reply({ formErrors: errors }) }, { status: 400 })
    }

    // RBAC: provider must be valid + in allowed scope
    const provider = await prisma.provider.findUnique({
        where: { id: providerId },
        include: { providerGroup: true },
    })
    if (!provider || (provider.customerId !== user.customerId && !isSystemAdmin)) {
        return data({ result: parsed.reply({ formErrors: ['Invalid provider selection'] }) }, { status: 400 })
    }
    if (!provider.active) {
        return data({ result: parsed.reply({ formErrors: ['Selected provider is inactive'] }) }, { status: 400 })
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

    // Build PCG payload from normalized values
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
        document_set: documents.map((d: any) => ({
            name: d.name,
            split_no: d.split_no,
            filename: d.filename,
            document_type: d.document_type,
            attachmentControlNum: d.attachmentControlNum,
        })),
    })

    // ======================================
    // Retry Flow — Update row then re-create
    // ======================================
    if (retrySubmissionId) {
        const existing = await prisma.submission.findUnique({ where: { id: retrySubmissionId } })
        if (!existing) {
            return data({ result: parsed.reply({ formErrors: ['Retry submission not found'] }) }, { status: 404 })
        }

        // Keep status as ERROR until PCG accepts the re-create
        await prisma.submission.update({
            where: { id: retrySubmissionId },
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
                providerId,
                status: 'ERROR',
            },
        })

        // Audit the payload we’re about to send
        await prisma.submissionEvent.create({
            data: {
                submissionId: retrySubmissionId,
                kind: 'DRAFT_CREATED',
                message: 'Local draft updated for retry (payload audit)',
                payload: pcgPayload,
            },
        })

        try {
            const pcgResp = await pcgCreateSubmission(pcgPayload)
            if (!pcgResp?.submission_id) throw new Error('PCG did not return a submission_id')

            await prisma.submission.update({
                where: { id: retrySubmissionId },
                data: { pcgSubmissionId: pcgResp.submission_id, responseMessage: 'Draft', status: 'DRAFT' },
            })

            await prisma.submissionEvent.create({
                data: {
                    submissionId: retrySubmissionId,
                    kind: 'PCG_CREATE_SUCCESS',
                    message: `PCG submission created (id ${pcgResp.submission_id})`,
                    payload: pcgResp,
                },
            })

            // Best-effort: immediately overwrite local with PCG snapshot
            try {
                await persistRemoteSnapshot(retrySubmissionId, pcgResp.submission_id)
            } catch {}

            return await redirectWithToast(
                `/customer/submissions/${retrySubmissionId}/review?draft=${encodeURIComponent(draftNonce)}`,
                {
                    type: 'success',
                    title: 'Submission Created',
                    description: 'Metadata saved. Review your data next.',
                },
            )
        } catch (e: any) {
            await prisma.submission.update({
                where: { id: retrySubmissionId },
                data: { status: 'ERROR', errorDescription: e?.message?.toString?.() ?? 'Create failed' },
            })
            await prisma.submissionEvent.create({
                data: {
                    submissionId: retrySubmissionId,
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

    // ==========================
    // Normal Flow — First create
    // ==========================
    const newSubmission = await prisma.submission.create({
        data: {
            title,
            authorType: authorType,
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

    // Audit local draft creation (payload we’re about to send to PCG)
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

        // Best-effort: immediately overwrite local with PCG snapshot
        try {
            await persistRemoteSnapshot(newSubmission.id, pcgResp.submission_id)
        } catch {}

        return await redirectWithToast(
            `/customer/submissions/${newSubmission.id}/review?draft=${encodeURIComponent(draftNonce)}`,
            {
                type: 'success',
                title: 'Submission Created',
                description: 'Metadata saved. Review your data next.',
            },
        )
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

/* ======================================
   Component — NewSubmission (Step 1 UI)
   ======================================
   Drives the metadata form, recipient wiring, split/doc blocks,
   file pre-caching, and client-side validations.
*/
export default function NewSubmission() {
    const { user, availableNpis, retryInitial, retryInitialDocs } = useLoaderData<typeof loader>() as {
        user: any
        availableNpis: Npi[]
        retryInitial: (Record<string, any> & { retrySubmissionId: string; docCount?: number }) | null
        retryInitialDocs: Array<{ name: string; filename: string; attachmentControlNum: string }>
    }
    const actionData = useActionData<typeof action>()
    const nav = useNavigation()
    const navigate = useNavigate()
    const isSubmitting = nav.formData?.get('intent') === 'create'

    // Conform setup (validate onBlur; prefill when retrying)
    const [form, fields] = useForm({
        id: 'create-submission',
        constraint: getZodConstraint(CreateSubmissionSchema),
        onValidate({ formData }) {
            return parseWithZod(formData, { schema: CreateSubmissionSchema })
        },
        shouldRevalidate: 'onBlur',
        defaultValue: retryInitial ?? undefined,
    })

    // 🔧 Consistent control sizing across inputs & selects
    const CONTROL_BASE = 'mt-1 block w-full rounded-md text-sm'
    const INPUT_CLS = `${CONTROL_BASE} border border-gray-300 bg-white px-3 h-10 text-gray-900 focus:border-indigo-500 focus:ring-indigo-500`
    const SELECT_CLS = `${CONTROL_BASE} border border-gray-300 bg-white pl-3 pr-10 h-10 text-gray-900 focus:border-indigo-500 focus:ring-indigo-500`
    const READONLY_CLS = `${CONTROL_BASE} border border-gray-200 bg-gray-50 px-3 h-10 text-gray-700`

    // One-off nonce for draft cache keys (per tab)
    const [draftNonce] = React.useState(() => crypto.randomUUID())

    /* --------------------------------------------
       Purpose → Category → Recipient (dependent UI)
       -------------------------------------------- */
    const [purpose, setPurpose] = React.useState<SubmissionPurpose | ''>(
        (retryInitial?.purposeOfSubmission as SubmissionPurpose) || ''
    )

    type CategoryOpt = ReturnType<typeof categoriesForPurpose>[number]
    const categoryOptions: CategoryOpt[] = React.useMemo(
        () => (purpose ? categoriesForPurpose(purpose as SubmissionPurpose) : []),
        [purpose],
    )

    const isRecipientCategory = (v: string): v is RecipientCategory =>
        (RecipientCategories as readonly string[]).includes(v)

    const [categoryId, setCategoryId] = React.useState<RecipientCategory | ''>('')

    type RecipientOpt = { value: string; label: string }
    const recipientOptions: RecipientOpt[] = React.useMemo(
        () => (purpose && categoryId ? recipientsFor(categoryId, purpose as SubmissionPurpose) : []),
        [categoryId, purpose],
    )

    const [selectedRecipient, setSelectedRecipient] = React.useState<string>(retryInitial?.recipient || '')

    React.useEffect(() => {
        const hidId = fields.recipient?.id
        if (!hidId) return
        const hidden = document.getElementById(hidId) as HTMLInputElement | null
        if (hidden) hidden.value = selectedRecipient || ''
    }, [fields.recipient?.id, selectedRecipient])

    React.useEffect(() => {
        setCategoryId('')
        if (!retryInitial) setSelectedRecipient('')
    }, [purpose]) // eslint-disable-line react-hooks/exhaustive-deps

    const recipientHelp = React.useMemo(
        () => (selectedRecipient ? recipientHelperLabel(selectedRecipient) : undefined),
        [selectedRecipient],
    )

    /* ------------------------
       Split kind → Doc blocks
       ------------------------ */
    const [splitKind, setSplitKind] = React.useState<'' | 'manual' | 'auto'>(
        (retryInitial?.splitKind as 'manual' | 'auto') || 'manual'
    )
    const [docCount, setDocCount] = React.useState<number | ''>(
        (retryInitial?.docCount as number | undefined) ?? 1
    )

    React.useEffect(() => {
        const hidId = fields.autoSplit?.id
        if (!hidId) return
        const hidden = document.getElementById(hidId) as HTMLInputElement | null
        if (!hidden) return
        if (splitKind === 'manual') hidden.value = 'false'
        else if (splitKind === 'auto') hidden.value = 'true'
        else hidden.value = ''
    }, [splitKind, fields.autoSplit?.id])

    /* --------------------------
       Document UX + draft cache
       -------------------------- */
    const [dropErrors, setDropErrors] = React.useState<Record<number, string>>({})
    const [docPicked, setDocPicked] = React.useState<Record<number, boolean>>({})
    const [docFilled, setDocFilled] = React.useState<Record<number, boolean>>({})
    const [docSizes, setDocSizes] = React.useState<Record<number, number>>({})
    const [dzReset, setDzReset] = React.useState<Record<number, number>>({})
    const [initialFiles, setInitialFiles] = React.useState<Record<number, File | null>>({})

    type DocMeta = { name: string; filename: string; attachmentControlNum: string }
    const [docMeta, setDocMeta] = React.useState<Record<number, DocMeta>>(() => {
        if (!retryInitial || !retryInitialDocs?.length) return {}
        const seed: Record<number, DocMeta> = {}
        const count = Math.max(1, retryInitialDocs.length)
        for (let i = 1; i <= count; i++) {
            const preset = retryInitialDocs[i - 1]
            seed[i] = {
                name: preset?.name || '',
                filename: preset?.filename || '',
                attachmentControlNum: preset?.attachmentControlNum || '',
            }
        }
        return seed
    })

    const totalSizeMB = React.useMemo(
        () => Object.values(docSizes).reduce((a, b) => a + b, 0) / (1024 * 1024),
        [docSizes],
    )

    function computeFilled(m: DocMeta) {
        return Boolean(m.name.trim() && /\.pdf$/i.test(m.filename.trim()) && m.attachmentControlNum.trim())
    }

    function updateDocMeta(i: number, patch: Partial<DocMeta>, recompute = true) {
        setDocMeta(prev => {
            const base: DocMeta = prev[i] ?? { name: '', filename: '', attachmentControlNum: '' }
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
        return base.replace(/\w\S*/g, (w: string) => w.charAt(0).toUpperCase() + w.slice(1))
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
            setDocSizes(prev => {
                const next = { ...prev }
                delete next[idx]
                return next
            })
            setDzReset(prev => ({ ...prev, [idx]: (prev[idx] ?? 0) + 1 }))
            return
        }

        setDropErrors(prev => ({ ...prev, [idx]: '' }))
        setDocPicked(prev => ({ ...prev, [idx]: true }))
        setDocSizes(prev => ({ ...prev, [idx]: file.size }))

        const current = docMeta[idx] ?? { name: '', filename: '', attachmentControlNum: '' }
        updateDocMeta(idx, { filename: file.name, name: current.name ? current.name : titleCaseFrom(file.name) }, true)

        try {
            await setCachedFile(draftKey(draftNonce, idx), file)
        } catch (e) {
            console.warn('cache write failed (non-blocking)', e)
        }
    }

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

                const base = docMeta[i] ?? { name: '', filename: '', attachmentControlNum: '' }
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

    React.useEffect(() => {
        setDocPicked({})
        setDocFilled({})
        setDropErrors({})
        setDocSizes({})
        setDzReset({})
        setInitialFiles({})

        if (splitKind) {
            const count = splitKind === 'manual' ? Number(docCount || 0) : 1
            const init: Record<number, DocMeta> = {}
            for (let i = 1; i <= (count || 0); i++) init[i] = { name: '', filename: '', attachmentControlNum: '' }

            if (retryInitial && retryInitialDocs?.length) {
                for (let i = 1; i <= Math.min(retryInitialDocs.length, count || 0); i++) {
                    init[i] = {
                        name: retryInitialDocs[i - 1]?.name || '',
                        filename: retryInitialDocs[i - 1]?.filename || '',
                        attachmentControlNum: retryInitialDocs[i - 1]?.attachmentControlNum || '',
                    }
                }
            }
            setDocMeta(init)
        } else {
            setDocMeta({})
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [splitKind, docCount])

    function validateBeforeSubmit(): boolean {
        const errs: string[] = []

        if (!splitKind) errs.push('Select a Split kind.')
        if (splitKind === 'manual' && !docCount) errs.push('Select the Number of documents.')

        const count = splitKind === 'manual' ? Number(docCount || 0) : splitKind === 'auto' ? 1 : 0
        for (let i = 1; i <= count; i++) {
            const m = docMeta[i] ?? { name: '', filename: '', attachmentControlNum: '' }
            if (!m.name.trim()) errs.push(`Document #${i}: “Document Name” is required.`)
            if (!m.filename.trim()) errs.push(`Document #${i}: “Filename” is required.`)
            else if (!/\.pdf$/i.test(m.filename.trim())) errs.push(`Document #${i}: “Filename” must end with .pdf.`)
            if (!m.attachmentControlNum.trim()) errs.push(`Document #${i}: “Attachment Control Number” is required.`)
            if (dropErrors[i]) errs.push(`Document #${i}: ${dropErrors[i]}`)
        }

        if (errs.length) {
            window.alert(`Please fix the following issues before continuing:\n\n• ${errs.join('\n• ')}`)
            return false
        }
        return true
    }

    React.useEffect(() => {
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.body.style.overflow = prev || ''
        }
    }, [])

    /* ===== Render ===== */
    return (
        <>
            <LoadingOverlay
                show={Boolean(isSubmitting)}
                title="Creating submission…"
                message="Please don't refresh or close this tab while we create the draft in PCG."
            />

            <Drawer
                key="drawer-new"
                isOpen
                onClose={() => navigate('/customer/submissions')}
                title="Create New Submission"
                size="fullscreen"
            >
                <Form
                    method="POST"
                    {...getFormProps(form)}
                    className="space-y-6"
                    onSubmit={e => {
                        if (!validateBeforeSubmit()) e.preventDefault()
                    }}
                >
                    {/* Hidden fields */}
                    <input type="hidden" name="intent" value="create" />
                    <input type="hidden" name="draftNonce" value={draftNonce} />
                    {retryInitial?.retrySubmissionId ? (
                        <input type="hidden" name="retrySubmissionId" value={retryInitial.retrySubmissionId} />
                    ) : null}
                    <input {...getInputProps(fields.recipient!, { type: 'hidden' })} />
                    <input {...getInputProps(fields.autoSplit!, { type: 'hidden' })} />

                    {/* ===== Submission Details ===== */}
                    <div className="rounded-lg border border-gray-200 bg-white p-4">
                        <h3 className="text-base font-semibold text-gray-900 mb-4">Submission Details</h3>

                        <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                            {/* Title (8) */}
                            <div className="md:col-span-8">
                                <Field
                                    labelProps={{ children: 'Title *' }}
                                    inputProps={{
                                        ...getInputProps(fields.title!, { type: 'text' }),
                                        placeholder: 'Enter submission title',
                                        className: INPUT_CLS,
                                    }}
                                    errors={fields.title?.errors}
                                />
                            </div>

                            {/* Author Type (4) */}
                            <div className="md:col-span-4">
                                <SelectField
                                    labelProps={{ children: 'Author Type *' }}
                                    selectProps={{ ...getSelectProps(fields.authorType!), className: SELECT_CLS }}
                                    errors={fields.authorType?.errors}
                                >
                                    <option value="">Select author type</option>
                                    {AuthorTypeEnum.options.map(a => (
                                        <option key={a} value={a}>
                                            {formatEnum(a)}
                                        </option>
                                    ))}
                                </SelectField>
                            </div>

                            {/* Purpose (4) */}
                            <div className="md:col-span-4">
                                <SelectField
                                    labelProps={{ children: 'Purpose of Submission *' }}
                                    selectProps={{
                                        ...getSelectProps(fields.purposeOfSubmission!),
                                        className: SELECT_CLS,
                                        onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                                            const v = e.target.value as SubmissionPurpose | ''
                                            setPurpose(v)
                                            const el = e.currentTarget
                                            const nativeSetter = (Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value') as any)?.set
                                            nativeSetter?.call(el, v)
                                            el.dispatchEvent(new Event('input', { bubbles: true }))
                                            el.dispatchEvent(new Event('change', { bubbles: true }))
                                        },
                                    }}
                                    errors={fields.purposeOfSubmission?.errors}
                                >
                                    <option value="">Select purpose</option>
                                    {SubmissionPurposeValues.map(p => (
                                        <option key={p} value={p}>
                                            {formatEnum(p)}
                                        </option>
                                    ))}
                                </SelectField>
                            </div>

                            {/* Recipient (8) — Category + Recipient OID */}
                            <div className="md:col-span-8">
                                <label className="block text-sm font-medium text-gray-700">Recipient *</label>

                                <div className="mt-1 grid grid-cols-12 gap-2">
                                    {/* Category (5) */}
                                    <select
                                        value={categoryId}
                                        onChange={e => {
                                            const raw = e.target.value.trim()
                                            setCategoryId(isRecipientCategory(raw) ? raw : '')
                                            setSelectedRecipient('')
                                        }}
                                        disabled={!purpose}
                                        className={`col-span-5 ${SELECT_CLS}`}
                                        aria-label="Recipient Category"
                                    >
                                        <option value="" disabled>
                                            {purpose ? 'Select category' : 'Select purpose first'}
                                        </option>
                                        {categoryOptions.map(c => (
                                            <option key={c.value} value={c.value} disabled={Boolean(c.disabled)}>
                                                {c.label}
                                            </option>
                                        ))}
                                    </select>

                                    {/* Recipient (7) */}
                                    <select
                                        value={selectedRecipient}
                                        onChange={e => setSelectedRecipient(e.target.value)}
                                        disabled={!categoryId || recipientOptions.length === 0}
                                        className={`col-span-7 ${SELECT_CLS}`}
                                        aria-label="Recipient OID"
                                    >
                                        <option value="" disabled>
                                            {categoryId
                                                ? recipientOptions.length ? 'Select recipient' : 'No recipients for this purpose'
                                                : 'Select category first'}
                                        </option>
                                        {recipientOptions.map(opt => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                </div>

                                {recipientHelp ? <p className="mt-1 text-xs text-gray-500">{recipientHelp}</p> : null}

                                <ErrorList
                                    errors={fields.recipient?.errors}
                                    id={`${fields.recipient?.id ?? 'recipient'}-errors`}
                                />
                            </div>

                            {/* Heads-up */}
                            <div className="md:col-span-12 -mt-1 rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
                                <strong>Heads up:</strong> Choose the appropriate <span className="font-semibold">purpose of submission</span> and <span className="font-semibold">recipient</span> because we cannot change these after creating a submission.
                            </div>

                            {/* NPI (4) */}
                            <div className="md:col-span-4">
                                <SelectField
                                    labelProps={{ children: 'NPI *' }}
                                    selectProps={{ ...getSelectProps(fields.providerId!), className: SELECT_CLS }}
                                    errors={fields.providerId?.errors}
                                >
                                    <option value="">Select NPI</option>
                                    {availableNpis.map(p => (
                                        <option key={p.id} value={p.id}>
                                            {p.npi}
                                            {p.name ? ` - ${p.name}` : ''}
                                        </option>
                                    ))}
                                </SelectField>
                            </div>

                            {/* Claim ID (4) */}
                            <div className="md:col-span-4">
                                <Field
                                    labelProps={{ children: 'Claim ID *' }}
                                    inputProps={{ ...getInputProps(fields.claimId!, { type: 'text' }), className: INPUT_CLS }}
                                    errors={fields.claimId?.errors}
                                />
                            </div>

                            {/* Case ID (4) */}
                            <div className="md:col-span-4">
                                <Field
                                    labelProps={{ children: 'Case ID' }}
                                    inputProps={{
                                        ...getInputProps(fields.caseId!, { type: 'text' }),
                                        placeholder: 'Up to 32 chars',
                                        maxLength: 32,
                                        className: INPUT_CLS,
                                    }}
                                    errors={fields.caseId?.errors}
                                />
                            </div>

                            {/* Comments (12) — textarea intentionally taller */}
                            <div className="md:col-span-12">
                                <TextareaField
                                    labelProps={{ children: 'Comments' }}
                                    textareaProps={{
                                        ...getInputProps(fields.comments!, { type: 'text' }),
                                        rows: 3,
                                        placeholder: 'Notes (optional)',
                                        className: 'text-gray-900 placeholder-gray-400',
                                    }}
                                    errors={fields.comments?.errors}
                                />
                            </div>

                            {/* Send in X12 (6) */}
                            <div className="md:col-span-6">
                                <SelectField
                                    labelProps={{ children: 'Send in X12' }}
                                    selectProps={{ ...getSelectProps(fields.sendInX12!), className: SELECT_CLS }}
                                    errors={fields.sendInX12?.errors}
                                >
                                    <option value="false">False</option>
                                    <option value="true">True</option>
                                </SelectField>
                            </div>

                            {/* Threshold (6) */}
                            <div className="md:col-span-6">
                                <Field
                                    labelProps={{ children: 'Threshold' }}
                                    inputProps={{ ...getInputProps(fields.threshold!, { type: 'number' }), min: 1, placeholder: '100', className: INPUT_CLS }}
                                    errors={fields.threshold?.errors}
                                />
                            </div>
                        </div>
                    </div>

                    {/* ===== Split Settings ===== */}
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
                                        if (v === 'auto') setDocCount('') // docCount only applies to manual mode
                                        setDocPicked({})
                                        setDocFilled({})
                                        setDropErrors({})
                                        setDocSizes({})
                                        setDzReset({})
                                    }}
                                    className={SELECT_CLS}
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
                                    className={READONLY_CLS}
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
                                        className={SELECT_CLS}
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
                                    const meta = docMeta[i] ?? { name: '', filename: '', attachmentControlNum: '' }
                                    return (
                                        <div key={i} className="mb-4 rounded-md border border-gray-200 p-3">
                                            <div className="mb-2 text-sm font-medium text-gray-700">Document #{i}</div>

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
                                                        className={READONLY_CLS}
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
                                                        className={INPUT_CLS}
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
                                                        className={INPUT_CLS}
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
                                                        className={INPUT_CLS}
                                                        placeholder={DEFAULT_ACN_HINT}
                                                    />
                                                </div>

                                                <div className="md:col-span-6">
                                                    <label className="block text-sm text-gray-700">Document Type</label>
                                                    <input
                                                        type="text"
                                                        readOnly
                                                        value="pdf"
                                                        className={READONLY_CLS}
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

                    {/* ===== Footer Actions ===== */}
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

                    {/* Server-side form errors */}
                    <ErrorList
                        errors={actionData && 'result' in actionData ? (actionData as any).result?.error?.formErrors : []}
                        id={form.errorId}
                    />
                </Form>
            </Drawer>
        </>
    )
}
