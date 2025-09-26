// app/routes/customer+/$id.review.tsx

/**
 * Step 2 of 3 — Review / Update Submission Metadata
 * --------------------------------------------------
 * This route:
 * - Loads the existing submission (must be a PCG "Draft").
 * - Refreshes local DB with the latest PCG status (single snapshot in loader).
 * - Prefills a Conform form so users can tweak metadata before uploading files.
 * - Allows manual/auto split selection and per-document metadata editing.
 * - Caches selected files client-side (submission cache) before the actual upload step.
 * - Sends an "update" to PCG and records audit + submission events.
 *
 * NOTE:
 * - Recipient and Purpose can be edited here; action validates and updates PCG accordingly.
 * - We do not double-fetch PCG status in the action; loader does it once on load.
 */

import { getFormProps, getInputProps, getSelectProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { SubmissionEventKind, type SubmissionPurpose as PrismaSubmissionPurpose } from '@prisma/client'
import * as React from 'react'
import {
    data,
    Form,
    useActionData,
    useLoaderData,
    useNavigation,
    Link,
    useNavigate,
    useLocation,
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { INPUT_CLS, SELECT_CLS, READONLY_CLS } from '#app/components/control-classes.ts'
import { FileDropzone } from '#app/components/file-dropzone.tsx'
// (moved below)
import { Field, SelectField, TextareaField, ErrorList } from '#app/components/forms.tsx'
import { SubmissionActivityLog } from '#app/components/submission-activity-log.tsx'
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
    getRecipientByOid,
    categoryForOid,
} from '#app/domain/submission-enums.ts'
import { audit } from '#app/services/audit.server.ts'
import { buildCreateSubmissionPayload, pcgUpdateSubmission, pcgGetStatus } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { draftKey, moveCachedFile, subKey, getCachedFile, setCachedFile } from '#app/utils/file-cache.ts'
import { extractRequestContext } from '#app/utils/request-context.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'
import { BYTES_PER_MB, MAX_TOTAL_MB, totalsNoteFor, perFileLimitFor } from '#app/utils/upload-constraints.ts'

/** Lightweight types used across loader/UI */
type PcgEvent = { kind?: string; payload?: any }
type PcgStageSource = { responseMessage?: string | null; events?: PcgEvent[] | any[] }

/**
 * PCG "Draft" detector
 * - PCG can surface the stage either in the response message or within a PCG_STATUS event payload.
 * - We prefer the event's stage if present, otherwise fallback to responseMessage, defaulting to "Draft".
 */
function isDraftFromPCG(s: PcgStageSource | null | undefined) {
    if (!s) return false
    const stageFromResponse = (s.responseMessage ?? '').toLowerCase()
    const stageFromEvent = ((s.events ?? []).find((e: any) => e?.kind === 'PCG_STATUS')?.payload?.stage ?? '').toLowerCase()
    const latestStage = stageFromEvent || stageFromResponse || 'Draft'
    return latestStage.includes('draft')
}

/** NPI (provider) minimal surface for selects */
type Npi = { id: string; npi: string; name: string | null }

const DEFAULT_ACN_HINT = 'Please specify attachment control number'

/**
 * Base schema for the Step-2 "update" form
 * - docCount is dynamic (handled by our manual block rendering),
 *   so the schema just tolerates it; specific doc subfields validated separately.
 */
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
    splitKind: z.enum(['manual', 'auto'], { required_error: 'Split kind is required' }),
    docCount: z.preprocess(v => (v === '' ? undefined : v), z.coerce.number().int()).optional(),
    autoSplit: z.enum(['true', 'false']).transform(v => v === 'true'),
    sendInX12: z.enum(['true', 'false']).transform(v => v === 'true'),
    threshold: z.preprocess(v => (v === '' ? undefined : v), z.coerce.number().int().min(1).default(100)),
    _initial_json: z.string().optional(),
})

/** ===== Helpers to apply PCG Status → local DB ===== */

/** Normalize OID values that may arrive as 'urn:oid:<value>' or plain. */
function normalizeOid(oid?: string | null) {
    if (!oid) return undefined
    const s = String(oid)
    return s.startsWith('urn:oid:') ? s.slice('urn:oid:'.length) : s
}

/**
 * PCG → Prisma purpose mapping
 * - PCG returns contentType codes; we map known values to local enum.
 * - If unknown, leave it unchanged (undefined).
 */
function mapPcgPurposeCodeToLocalEnum(code?: string | null): PrismaSubmissionPurpose | undefined {
    const c = (code ?? '').trim()
    if (!c) return undefined
    switch (c) {
        case '1': return 'ADR' as PrismaSubmissionPurpose
        case '7': return 'PWK_CLAIM_DOCUMENTATION' as PrismaSubmissionPurpose
        case '9': return 'FIRST_APPEAL' as PrismaSubmissionPurpose
        case '9.1': return 'SECOND_APPEAL' as PrismaSubmissionPurpose
        default: return undefined
    }
}

/**
 * Fetch PCG status (best-effort), create a PCG_STATUS event,
 * then overwrite local DB fields with authoritative data from PCG.
 * Swallows failures so the loader UX isn't blocked.
 */
async function applyStatusToDb(submissionId: string, pcgSubmissionId: string) {
    try {
        const statusResp = await pcgGetStatus(pcgSubmissionId)
        const s: any = statusResp as any

        await prisma.submissionEvent.create({
            data: {
                submissionId,
                kind: 'PCG_STATUS',
                message: statusResp.stage ?? 'Status retrieved',
                payload: statusResp,
            },
        })

        // Normalize possible transaction ID fields from PCG
    const rawTxnList = (s?.transactionIdList) || (s?.uniqueIdList) || ''
        const normalizedTxnList = typeof rawTxnList === 'string' ? rawTxnList.trim() : ''
    const txn = s.esmdTransactionId ?? (normalizedTxnList || null)

        // Project snapshot fields into our submission row
        const updateData: any = {
            responseMessage: statusResp.stage ?? undefined,
            transactionId: txn ?? undefined,
            title: s.title ?? undefined,
            claimId: s.esmdClaimId ?? undefined,
            caseId: s.esmdCaseId ?? undefined,
            authorType: s.authorType ?? undefined,
            autoSplit: typeof s.autoSplit === 'boolean' ? s.autoSplit : undefined,
            comments: s.comments ?? undefined,
            recipient: normalizeOid(s.intendedRecipient?.oid) ?? undefined,
            updatedAt: new Date(),
        }
        const mappedPurpose = mapPcgPurposeCodeToLocalEnum(s.purposeOfSubmission?.contentType)
        if (mappedPurpose) updateData.purposeOfSubmission = mappedPurpose

        // Optional combined errors in a single surface
        const allErrors = [
            ...(statusResp.errorList ?? []),
            ...(s.errors ?? []),
        ]
        if (allErrors.length) {
            updateData.errorDescription = allErrors
                .map((e: any) => (typeof e === 'string' ? e : e?.message ?? JSON.stringify(e)))
                .join('; ')
        }

        await prisma.submission.update({ where: { id: submissionId }, data: updateData })
    } catch {
        // swallow; we don't want to block UX if status refresh fails
    }
}

/**
 * Loader
 * - Authenticates user.
 * - Loads submission + events.
 * - Refreshes single PCG status snapshot (if pcgSubmissionId exists).
 * - Validates "Draft" stage (only drafts are editable).
 * - Computes allowed NPIs based on RBAC.
 * - Prepares initial form values + document set.
 */
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

    const id = params.id as string
    let submission = await prisma.submission.findFirst({
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

    // ===== REFRESH STATUS when resuming Step-2 (Continue/Retry) =====
    if (submission.pcgSubmissionId) {
        await applyStatusToDb(submission.id, submission.pcgSubmissionId)
        // re-read for latest values & new PCG_STATUS event
        submission = await prisma.submission.findFirst({
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
    }

    // Only editable in Draft stage (per PCG)
    if (!isDraftFromPCG(submission)) {
        throw await redirectWithToast(`/customer/submissions`, {
            type: 'error',
            title: 'Not editable',
            description: 'Only draft submissions (from PCG) can be reviewed or updated.',
        })
    }
    // Must have a PCG submission id to continue
    if (!submission.pcgSubmissionId) {
        throw await redirectWithToast(`/customer/submissions/new`, {
            type: 'error',
            title: 'Missing submission_id',
            description: 'Create the submission first.',
        })
    }

    // RBAC → available NPIs list
    const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(r => r.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin') || isCustomerAdmin

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

    // Compose initial form values from latest META_UPDATED or DRAFT_CREATED payload
    const metaEvent =
        submission.events.find(e => e.kind === SubmissionEventKind.META_UPDATED) ??
        submission.events.find(e => e.kind === SubmissionEventKind.DRAFT_CREATED)
    const latestMeta = (metaEvent?.payload as any) ?? {}
    const docSet = Array.isArray(latestMeta?.document_set) ? latestMeta.document_set : []

    const initial = {
        submissionId: submission.id,
        title: latestMeta?.name ?? submission.title,
        authorType:
            latestMeta?.author_type ?? (submission.authorType?.toLowerCase() === 'institutional' ? 'institutional' : 'individual'),
        purposeOfSubmission: (latestMeta?.purposeOfSubmission ?? submission.purposeOfSubmission) as PrismaSubmissionPurpose,
        recipient: latestMeta?.intended_recepient ?? submission.recipient,
        providerId: submission.provider.id,
        claimId: latestMeta?.esMD_claim_id ?? submission.claimId ?? '',
        caseId: latestMeta?.esmd_case_id ?? submission.caseId ?? '',
        comments: latestMeta?.comments ?? submission.comments ?? '',
        splitKind: (latestMeta?.auto_split ?? submission.autoSplit) ? 'auto' : 'manual',
        autoSplit: String(Boolean(latestMeta?.auto_split ?? submission.autoSplit)),
        sendInX12: String(Boolean(latestMeta?.bSendinX12 ?? submission.sendInX12)),
        threshold: Number(latestMeta?.threshold ?? submission.threshold ?? 100),
    }

    // Prepare a UI-safe view of events (ISO strings for dates)
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
        initialJson: JSON.stringify({ ...initial, docCount: docSet.length }),
        availableNpis,
        initialDocs: docSet.map((d: any) => ({
            name: d.name || '',
            filename: d.filename || '',
            attachmentControlNum: d.attachmentControlNum || '',
        })),
    })
}

/**
 * Extract N document blocks from the form.
 * Validates per-document fields and returns both the shaped list and errors.
 */
function collectDocuments(formData: FormData, kind: 'manual' | 'auto', docCount?: number) {
    const errors: string[] = []
    const count = kind === 'manual' ? Number(docCount) : 1
    if (kind === 'manual' && (isNaN(count) || count < 1 || count > 99)) {
        errors.push('Number of documents must be between 1 and 99 for manual split.')
    }
    const documents: Array<{ name: string; filename: string; attachmentControlNum: string; split_no: number; document_type: 'pdf' }> = []
    for (let i = 1; i <= (kind === 'manual' ? count : 1); i++) {
        const name = String(formData.get(`doc_name_${i}`) || '').trim()
        const filename = String(formData.get(`doc_filename_${i}`) || '').trim()
        const attachment = String(formData.get(`doc_attachment_${i}`) || '').trim()

        if (!name) errors.push(`Document ${i}: name is required`)
        if (!filename) errors.push(`Document ${i}: filename is required`)
        if (filename && !/\.pdf$/i.test(filename)) errors.push(`Document ${i}: filename must end with .pdf`)
        if (!attachment) errors.push(`Document ${i}: Attachment Control Number is required`)

        documents.push({ name, filename, attachmentControlNum: attachment, split_no: i, document_type: 'pdf' })
    }
    return { documents, errors }
}

/**
 * Action — Updates metadata both locally and on PCG
 * - Validates request.
 * - Enforces RBAC against the chosen provider.
 * - Validates/collects document block fields.
 * - Sends update to PCG (pcgUpdateSubmission).
 * - Writes META_UPDATED + PCG_UPDATE_* events.
 * - Writes audit log with changed-field diff (best-effort).
 * - Redirects back to the same review route (loader refreshes PCG once).
 */
export async function action({ request }: ActionFunctionArgs) {
    const userId = await requireUserId(request)
    const formData = await request.formData()
    const parsed = parseWithZod(formData, { schema: UpdateSubmissionMetaSchema })
    if (parsed.status !== 'success') {
        return data({ result: parsed.reply() }, { status: parsed.status === 'error' ? 400 : 200 })
    }
    const v = parsed.value as any
    // Validate recipient against purpose mapping (defensive server guard)
    try {
        const cat = categoryForOid(v.recipient)
        if (!cat) {
            return data({ result: parsed.reply({ formErrors: ['Recipient is not recognized. Please choose a valid recipient.'] }) }, { status: 400 })
        }
        const allowed = recipientsFor(cat, v.purposeOfSubmission as SubmissionPurpose)
        if (!allowed.some(o => o.value === v.recipient)) {
            return data({ result: parsed.reply({ formErrors: ['Selected recipient is not valid for the chosen purpose.'] }) }, { status: 400 })
        }
    } catch {}


    // Require existing submission and that it is still Draft + has pcgSubmissionId
    const submission = await prisma.submission.findUnique({ where: { id: v.submissionId }, include: { provider: true } })
    if (!submission) return data({ result: parsed.reply({ formErrors: ['Submission not found'] }) }, { status: 404 })
    if (!isDraftFromPCG(submission)) {
        return data({ result: parsed.reply({ formErrors: ['Only draft submissions can be updated'] }) }, { status: 400 })
    }
    if (!submission.pcgSubmissionId) {
        return data({ result: parsed.reply({ formErrors: ['Remote submission_id not available'] }) }, { status: 400 })
    }

    // RBAC: the chosen provider must be valid + within user's scope
    const user = await prisma.user.findUnique({
        where: { id: userId },
        include: { roles: true, customer: true, providerGroup: true, userNpis: { include: { provider: true } } },
    })
    if (!user) throw new Response('Unauthorized', { status: 401 })

    const isSystemAdmin = user.roles.some(r => r.name === 'system-admin')
    const isCustomerAdmin = user.roles.some(r => r.name === 'customer-admin') || isSystemAdmin
    const isProviderGroupAdmin = user.roles.some(r => r.name === 'provider-group-admin') || isCustomerAdmin

    const provider = await prisma.provider.findUnique({ where: { id: v.providerId }, include: { providerGroup: true } })
    if (!provider || (!isSystemAdmin && provider.customerId !== user.customerId)) {
        return data({ result: parsed.reply({ formErrors: ['Invalid provider (NPI) selection'] }) }, { status: 400 })
    }
    if (!provider.active) {
        return data({ result: parsed.reply({ formErrors: ['Selected provider is inactive'] }) }, { status: 400 })
    }
    if (!isSystemAdmin) {
        if (isProviderGroupAdmin && user.providerGroupId) {
            if (provider.providerGroupId !== user.providerGroupId) {
                return data({ result: parsed.reply({ formErrors: ['Provider not in your group'] }) }, { status: 400 })
            }
        } else if (!isCustomerAdmin) {
            const hasAccess = user.userNpis.some(un => un.providerId === v.providerId)
            if (!hasAccess) {
                return data(
                    { result: parsed.reply({ formErrors: ['You can only use NPIs assigned to you'] }) },
                    { status: 400 },
                )
            }
        }
    }

    // Validate and shape document metadata
    const { documents, errors } = collectDocuments(formData, v.splitKind, v.docCount)
    if (errors.length) return data({ result: parsed.reply({ formErrors: errors }) }, { status: 400 })

    // Construct PCG payload (same builder used by create flow for consistency)
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
        document_set: documents.map(d => ({
            name: d.name,
            split_no: d.split_no,
            filename: d.filename,
            document_type: d.document_type,
            attachmentControlNum: d.attachmentControlNum,
        })),
    })

    const ctx = await extractRequestContext(request, { requireUser: false })
    try {
        // Push update to PCG
        const resp = await pcgUpdateSubmission(submission.pcgSubmissionId, pcgPayload)

        // Normalize authorType casing in DB
        const authorTypeDb =
            v.authorType === 'institutional' ? 'Institutional' : 'Individual'

        // Persist local submission changes
        await prisma.submission.update({
            where: { id: v.submissionId },
            data: {
                title: v.title,
                purposeOfSubmission: v.purposeOfSubmission as PrismaSubmissionPurpose,
                recipient: v.recipient,
                claimId: v.claimId || null,
                caseId: v.caseId || null,
                comments: v.comments || null,
                autoSplit: v.autoSplit,
                sendInX12: v.sendInX12,
                threshold: v.threshold,
                authorType: authorTypeDb,
                providerId: v.providerId,
                updatedAt: new Date(),
            },
        })

        // Event log: keep a local audit of what we sent + PCG outcome
        await prisma.submissionEvent.create({
            data: { submissionId: v.submissionId, kind: SubmissionEventKind.META_UPDATED, message: 'Local metadata updated', payload: pcgPayload },
        })
        await prisma.submissionEvent.create({
            data: {
                submissionId: v.submissionId,
                kind: 'PCG_UPDATE_SUCCESS',
                message: resp?.status ?? 'update success',
                payload: { pcgSubmissionId: submission.pcgSubmissionId, response: resp },
            },
        })

        // NOTE: Do NOT refresh PCG status here.
        // We redirect back to the review route where the loader
        // calls applyStatusToDb() once. This avoids duplicate PCG_STATUS events.

        // Audit: submission updated with diff (best-effort)
        try {
            const prev: Record<string, unknown> | null = (() => {
                if (!v?._initial_json) return null
                try { return JSON.parse(v._initial_json) as Record<string, unknown> } catch { return null }
            })()
            const changed: string[] = []
            if (prev) {
                const keys = ['title','authorType','purposeOfSubmission','recipient','providerId','claimId','caseId','comments','autoSplit','sendInX12','threshold']
                for (const k of keys) {
                    const beforeVal = String((prev as Record<string, unknown>)[k] ?? '')
                    const afterVal = String((k === 'authorType' ? (v.authorType === 'institutional' ? 'Institutional' : 'Individual') : v[k]) ?? '')
                    if (beforeVal !== afterVal) changed.push(k)
                }
            }
            await audit.submission({
                action: 'SUBMISSION_UPDATED',
                actorType: 'USER',
                actorId: userId,
                customerId: submission.customerId ?? undefined,
                entityType: 'SUBMISSION',
                entityId: v.submissionId,
                requestId: ctx.requestId,
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                summary: 'Submission metadata updated',
                metadata: {
                    pcgSubmissionId: submission.pcgSubmissionId,
                    changed,
                    providerId: v.providerId,
                    purposeOfSubmission: v.purposeOfSubmission,
                    autoSplit: v.autoSplit,
                    sendInX12: v.sendInX12,
                    threshold: v.threshold,
                    documentCount: documents.length,
                },
            })
        } catch {}

        // Back to review; loader will refresh status once.
        return await redirectWithToast(`/customer/submissions/${v.submissionId}/review`, {
            type: 'success',
            title: 'Submission Updated',
            description: resp?.status ?? 'PCG accepted updated metadata.',
        })
    } catch (e: any) {
        // Record PCG update failure to events + audit
        await prisma.submissionEvent.create({
            data: { submissionId: v.submissionId, kind: 'PCG_UPDATE_ERROR', message: e?.message?.toString?.() ?? 'Update failed' },
        })
        // Audit: submission update error
        try {
            await audit.submission({
                action: 'SUBMISSION_UPDATE_ERROR',
                actorType: 'USER',
                actorId: userId,
                customerId: submission.customerId ?? undefined,
                entityType: 'SUBMISSION',
                entityId: v.submissionId,
                requestId: ctx.requestId,
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                status: 'FAILURE',
                summary: 'Submission metadata update failed',
                message: e?.message?.toString?.() ?? 'Update failed',
                metadata: { pcgSubmissionId: submission.pcgSubmissionId },
            })
        } catch {}

        return await redirectWithToast(`/customer/submissions/${v.submissionId}/review`, {
            type: 'error',
            title: 'Update Failed',
            description: e?.message?.toString?.() ?? 'Unable to update submission metadata',
        })
    }
}

/**
 * Component — ReviewSubmission
 * - Renders the Step-2 review UI.
 * - Allows editing Purpose & Recipient with dependent select mapping.
 * - Manages split/document blocks and submission cache for files.
 * - Provides an "Update Submission" toggle gate to avoid accidental updates.
 */
export default function ReviewSubmission() {
    const loaderData = useLoaderData<typeof loader>()
    const { submission, initial, initialJson, initialDocs } = loaderData
    const availableNpis: Npi[] = loaderData.availableNpis ?? []

    const actionData = useActionData<typeof action>()
    const nav = useNavigation()
    const navigate = useNavigate()
    const location = useLocation()
    const isUpdating = nav.formData?.get('intent') === 'update-submission'

    // Conform form binding; validate onBlur; start from loader-provided defaults
    const [form, fields] = useForm({
        id: 'review-submission',
        constraint: getZodConstraint(UpdateSubmissionMetaSchema),
        onValidate({ formData }) {
            return parseWithZod(formData, { schema: UpdateSubmissionMetaSchema })
        },
        shouldRevalidate: 'onBlur',
        defaultValue: initial,
    })

    // Control classes from shared module (kept consistent with Step 1)

    // ----- Purpose → Category → Recipient (no custom mode) -----
    const [purpose, setPurpose] = React.useState<SubmissionPurpose | ''>(
        (initial.purposeOfSubmission as SubmissionPurpose) || ''
    )

    // If the recipient OID does not exist in our directory, we show a hint to pick a valid one.
    const initialRecipientKnown = React.useMemo(
        () => Boolean(getRecipientByOid(initial.recipient ?? '')),
        [initial.recipient]
    )

    // Recipient is editable in review step

    // Category options (exact helper shape)
    type CategoryOpt = ReturnType<typeof categoriesForPurpose>[number]
    const categoryOptions: CategoryOpt[] = React.useMemo(
        () => (purpose ? categoriesForPurpose(purpose as SubmissionPurpose) : []),
        [purpose]
    )

    // Guard for category value
    const isRecipientCategory = (v: string): v is RecipientCategory =>
        (RecipientCategories as readonly string[]).includes(v)

    // Determine the initial category from the current (locked) recipient OID
    const initialCategory = React.useMemo<RecipientCategory | ''>(() => {
        if (!initialRecipientKnown) return ''
        const cat = categoryForOid(initial.recipient ?? '')
        return cat ?? ''
    }, [initial.recipient, initialRecipientKnown])

    const [categoryId, setCategoryId] = React.useState<RecipientCategory | ''>(initialCategory)

    // Compute the recipient list based on purpose + category
    type RecipientOpt = { value: string; label: string }
    const recipientOptions: RecipientOpt[] = React.useMemo(
        () => (purpose && categoryId ? recipientsFor(categoryId, purpose as SubmissionPurpose) : []),
        [categoryId, purpose]
    )

    const [selectedRecipient, setSelectedRecipient] = React.useState<string>(initialRecipientKnown ? (initial.recipient ?? '') : '')

    // If recipient changes (unlocked), ensure it's valid for current purpose/category; here it’s locked.
    React.useEffect(() => {
        if (!purpose) {
            setCategoryId('')
            setSelectedRecipient('')
            return
        }
        if (categoryId) {
            const options = recipientsFor(categoryId, purpose as SubmissionPurpose)
            if (!options.some(o => o.value === selectedRecipient)) {
                setSelectedRecipient('')
            }
        }
    }, [purpose, categoryId, selectedRecipient])

    // Keep hidden "recipient" input synced with selection
    React.useEffect(() => {
        const hidId = fields.recipient?.id
        if (!hidId) return
        const hidden = document.getElementById(hidId) as HTMLInputElement | null
        if (hidden) hidden.value = selectedRecipient || ''
    }, [fields.recipient?.id, selectedRecipient])

    const recipientHelp = React.useMemo(
        () => (selectedRecipient ? recipientHelperLabel(selectedRecipient) : undefined),
        [selectedRecipient],
    )

    // If purpose changed from the initial value, prompt to reselect recipient
    const purposeChanged = React.useMemo(
        () => Boolean(purpose) && String(initial.purposeOfSubmission || '') !== String(purpose || ''),
        [initial.purposeOfSubmission, purpose]
    )

    // Split kind + docCount state (docCount derived from initial doc set length)
    const [splitKind, setSplitKind] = React.useState<'manual' | 'auto'>(initial.splitKind as 'manual' | 'auto')
    const [docCount, setDocCount] = React.useState<number>(Math.max(1, initialDocs?.length ?? 1))

    // Keep hidden autoSplit input aligned with the splitKind select
    React.useEffect(() => {
        const hidId = fields.autoSplit?.id
        if (!hidId) return
        const hidden = document.getElementById(hidId) as HTMLInputElement | null
        if (hidden) hidden.value = splitKind === 'auto' ? 'true' : 'false'
    }, [splitKind, fields.autoSplit?.id])

    // ---- Cache wiring (submission-scoped) ----
    const [dropErrors, setDropErrors] = React.useState<Record<number, string>>({})
    const [ignoredDocPicked, setDocPicked] = React.useState<Record<number, boolean>>({})
    const [ignoredDocChanged, setDocChanged] = React.useState<Record<number, boolean>>({})
    const [docSizes, setDocSizes] = React.useState<Record<number, number>>({})
    const [dzReset, setDzReset] = React.useState<Record<number, number>>({})
    const [initialFiles, setInitialFiles] = React.useState<Record<number, File | null>>({})

    // Document metadata state (seed from initialDocs)
    type DocMeta = { name: string; filename: string; attachmentControlNum: string }
    const [docMeta, setDocMeta] = React.useState<Record<number, DocMeta>>(() => {
        const seed: Record<number, DocMeta> = {}
        const count = Math.max(1, initialDocs?.length ?? 1)
        for (let i = 1; i <= count; i++) {
            const preset = initialDocs?.[i - 1] || { name: '', filename: '', attachmentControlNum: '' }
            seed[i] = {
                name: preset.name || '',
                filename: preset.filename || '',
                attachmentControlNum: preset.attachmentControlNum || '',
            }
        }
        return seed
    })

    // Aggregate size display (client-side hint only)
    const totalSizeMB = React.useMemo(
        () => Object.values(docSizes).reduce((a, b) => a + b, 0) / (1024 * 1024),
        [docSizes],
    )

    // Track if a given doc block deviates from initial values (for UX hints or future logic)
    const hasChanged = React.useCallback((i: number, next: DocMeta) => {
        const preset = initialDocs?.[i - 1] || { name: '', filename: '', attachmentControlNum: '' }
        return (
            (next.name || '') !== (preset.name || '') ||
            (next.filename || '') !== (preset.filename || '') ||
            (next.attachmentControlNum || '') !== (preset.attachmentControlNum || '')
        )
    }, [initialDocs])

    /** Update per-document metadata state + "changed" tracking */
    function updateDocMeta(i: number, patch: Partial<DocMeta>) {
        setDocMeta(prev => {
            const base = prev[i] ?? { name: '', filename: '', attachmentControlNum: '' }
            const next = { ...base, ...patch }
            const merged = { ...prev, [i]: next }
            setDocChanged(p => ({ ...p, [i]: hasChanged(i, next) }))
            return merged
        })
    }

    /** Convert a filename into a nicer title-case suggestion (used when seeding name from picked file). */
    function titleCaseFrom(filename: string) {
        const base = filename.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim()
        return base.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1))
    }

    /**
     * If the user navigates back from Step 3 with ?draft=,
     * move files from the draft cache to the submission cache (one-time), then strip the param.
     */
    React.useEffect(() => {
        const params = new URLSearchParams(location.search)
        const draft = params.get('draft')
        if (!draft) return
        void (async () => {
            for (let i = 1; i <= docCount; i++) {
                await moveCachedFile(draftKey(draft, i), subKey(submission.id, i))
            }
            const url = new URL(window.location.href)
            url.searchParams.delete('draft')
            window.history.replaceState({}, '', url.toString())
            const next: Record<number, File | null> = {}
            const sizes: Record<number, number> = {}
            for (let i = 1; i <= docCount; i++) {
                const f = await getCachedFile(subKey(submission.id, i))
                next[i] = f ?? null
                if (f) {
                    sizes[i] = f.size
                    setDocPicked(p => ({ ...p, [i]: true }))
                    // if filename empty, seed from cache
                    setDocMeta(prev => {
                        const base = prev[i] ?? { name: '', filename: '', attachmentControlNum: '' }
                        const seeded = { ...base }
                        if (!seeded.filename) seeded.filename = f.name
                        if (!seeded.name) seeded.name = titleCaseFrom(f.name)
                        const merged = { ...prev, [i]: seeded }
                        setDocChanged(ch => ({ ...ch, [i]: hasChanged(i, seeded) }))
                        return merged
                    })
                }
            }
            setInitialFiles(next)
            setDocSizes(sizes)
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.key])

    /**
     * If the user edits a filename in the text field, mirror the change in the cached File (rename),
     * so later upload uses the desired filename.
     */
    async function maybeRenameCachedFileTo(i: number, desiredFilename: string) {
        if (!/\.pdf$/i.test(desiredFilename)) return
        const key = subKey(submission.id, i)
        const f = await getCachedFile(key)
        if (!f || f.name === desiredFilename) return
        const content = await f.arrayBuffer()
        const renamed = new File([content], desiredFilename, { type: f.type, lastModified: f.lastModified })
        await setCachedFile(key, renamed)
        setDocSizes(prev => ({ ...prev, [i]: renamed.size }))
        setInitialFiles(prev => ({ ...prev, [i]: renamed }))
    }

    /**
     * Handle dropzone pick:
     * - Guard PDF + per-file and per-submission limits
     * - Seed name/filename from the file if missing
     * - Write into submission cache
     */
    async function handlePick(idx: number, file: File) {
        const mb = file.size / BYTES_PER_MB
        const isPdf = /\.pdf$/i.test(file.name)

        const existingTotalBytes = Object.entries(docSizes).reduce(
            (sum, [k, v]) => sum + (Number(k) === idx ? 0 : v),
            0,
        )
        const wouldBeTotalMB = (existingTotalBytes + file.size) / BYTES_PER_MB

        let err = ''
    const perFileLimit = perFileLimitFor(splitKind)
        if (!isPdf) err = 'PDF only'
        else if (mb > perFileLimit) err = `This file is ${mb.toFixed(1)} MB — the per-file limit is ${perFileLimit} MB.`
        else if (wouldBeTotalMB > MAX_TOTAL_MB) err = `Total selected would be ${wouldBeTotalMB.toFixed(1)} MB — the submission limit is ${MAX_TOTAL_MB} MB.`
        if (err) {
            window.alert(err)
            setDropErrors(prev => ({ ...prev, [idx]: err }))
            setDocPicked(prev => ({ ...prev, [idx]: false }))
            setDocSizes(prev => { const next = { ...prev }; delete next[idx]; return next })
            setDzReset(prev => ({ ...prev, [idx]: (prev[idx] ?? 0) + 1 }))
            return
        }

        // Update UI first (non-blocking)
        setDropErrors(prev => ({ ...prev, [idx]: '' }))
        setDocPicked(prev => ({ ...prev, [idx]: true }))
        setDocSizes(prev => ({ ...prev, [idx]: file.size }))
        setInitialFiles(prev => ({ ...prev, [idx]: file }))

        const base = docMeta[idx] ?? { name: '', filename: '', attachmentControlNum: '' }
        const next = {
            filename: file.name,
            name: base.name ? base.name : titleCaseFrom(file.name),
        }
        updateDocMeta(idx, next)

        // Best-effort cache write AFTER UI updates
        try {
            await setCachedFile(subKey(submission.id, idx), file)
        } catch (e) {
            console.warn('cache write failed (non-blocking)', e)
        }
    }

    /**
     * On docCount change (e.g., switching split options),
     * hydrate from submission cache and seed missing name/filename fields.
     */
    React.useEffect(() => {
        void (async () => {
            const next: Record<number, File | null> = {}
            const sizes: Record<number, number> = {}
            for (let i = 1; i <= docCount; i++) {
                const f = await getCachedFile(subKey(submission.id, i))
                next[i] = f ?? null
                if (f) {
                    sizes[i] = f.size
                    setDocPicked(prev => ({ ...prev, [i]: true }))
                    setDocMeta(prev => {
                        const base = prev[i] ?? { name: '', filename: '', attachmentControlNum: '' }
                        const seeded = { ...base }
                        if (!seeded.filename) seeded.filename = f.name
                        if (!seeded.name) seeded.name = titleCaseFrom(f.name)
                        const merged = { ...prev, [i]: seeded }
                        setDocChanged(ch => ({ ...ch, [i]: hasChanged(i, seeded) }))
                        return merged
                    })
                }
            }
            setInitialFiles(next)
            setDocSizes(sizes)
        })()
    }, [docCount, submission.id, hasChanged])

    /** Client-side guardrails prior to POST; server revalidates everything. */
    function validateBeforeSubmit(): boolean {
        const errs: string[] = []
        const count = splitKind === 'manual' ? Number(docCount || 0) : 1

        if (!splitKind) errs.push('Select a Split kind.')
        if (splitKind === 'manual' && !docCount) errs.push('Select the Number of documents.')

        for (let i = 1; i <= count; i++) {
            const m = docMeta[i] ?? { name: '', filename: '', attachmentControlNum: '' }
            if (!m.name.trim()) errs.push(`Document #${i}: “Document Name” is required.`)
            if (!m.filename.trim()) errs.push(`Document #${i}: “Filename” is required.`)
            else if (!/\.pdf$/i.test(m.filename.trim())) errs.push(`Document #${i}: “Filename” must end with .pdf.`)
            if (!m.attachmentControlNum.trim()) {
                errs.push(`Document #${i}: “Attachment Control Number” is required.`)
            }
            if (dropErrors[i]) errs.push(`Document #${i}: ${dropErrors[i]}`)
        }

        if (errs.length) {
            window.alert(`Please fix the following issues before updating:\n\n• ${errs.join('\n• ')}`)
            return false
        }
        return true
    }

    // Lock background scroll while this fullscreen Drawer is mounted
    React.useEffect(() => {
        const prev = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
            document.body.style.overflow = prev || ''
        }
    }, [])

    return (
        <>
            {/* Overlay while action is pending */}
            <LoadingOverlay show={Boolean(isUpdating)} title="Updating submission…" message="Hold tight while we push your changes to PCG." />

            <Drawer key={`drawer-review-${submission.id}`} isOpen onClose={() => navigate('/customer/submissions')} title={`Review Submission: ${submission.title}`} size="fullscreen">
                <div className="space-y-8">
                    <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                        <strong>Heads up:</strong> Review and make any final changes to the submission metadata here. After you upload the file(s) in the next step, edits to metadata are disabled.
                    </div>

                    <Form
                        method="POST"
                        {...getFormProps(form)}
                        className="space-y-8"
                        onSubmit={e => {
                            if (!validateBeforeSubmit()) e.preventDefault()
                        }}
                    >
                        {/* Hidden plumbing for Conform + diff/audit */}
                        <input type="hidden" name="intent" value="update-submission" />
                        <input type="hidden" name="submissionId" value={submission.id} />
                        <input type="hidden" name="_initial_json" value={initialJson} />
                        <input {...getInputProps(fields.recipient, { type: 'hidden' })} />
                        <input {...getInputProps(fields.autoSplit, { type: 'hidden' })} />
                        {/* Purpose binds directly via SelectField; no hidden input needed */}

                        {/* ===== Submission Details ===== */}
                        <div className="rounded-lg border border-gray-200 bg-white p-4">
                            <h3 className="text-base font-semibold text-gray-900 mb-4">Submission Details</h3>

                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
                                <div className="md:col-span-6">
                                    <Field labelProps={{ children: 'Title *' }} inputProps={{ ...getInputProps(fields.title, { type: 'text' }), className: INPUT_CLS }} errors={fields.title?.errors} />
                                </div>

                                <div className="md:col-span-6">
                                    <SelectField labelProps={{ children: 'Author Type *' }} selectProps={{ ...getSelectProps(fields.authorType), className: SELECT_CLS }} errors={fields.authorType?.errors}>
                                        {AuthorTypeEnum.options.map((a: string) => (
                                            <option key={a} value={a}>
                                                {formatEnum(a)}
                                            </option>
                                        ))}
                                    </SelectField>
                                </div>

                                {/* Purpose (editable) */}
                                <div className="md:col-span-6">
                                    <SelectField
                                        labelProps={{ children: 'Purpose of Submission *' }}
                                        selectProps={{
                                            ...getSelectProps(fields.purposeOfSubmission!),
                                            className: SELECT_CLS,
                                            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                                                const v = e.target.value as SubmissionPurpose | ''
                                                setPurpose(v)
                                                // reset dependent fields
                                                setCategoryId('')
                                                setSelectedRecipient('')
                                                // ensure Conform receives the updated value
                                                const el = e.currentTarget
                                                const nativeSetter = (Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value') as any)?.set
                                                nativeSetter?.call(el, v)
                                                el.dispatchEvent(new Event('input', { bubbles: true }))
                                                el.dispatchEvent(new Event('change', { bubbles: true }))
                                            },
                                        }}
                                        errors={fields.purposeOfSubmission?.errors}
                                    >
                                        {SubmissionPurposeValues.map((p: string) => (
                                            <option key={p} value={p}>
                                                {formatEnum(p)}
                                            </option>
                                        ))}
                                    </SelectField>
                                </div>

                                {/* Recipient (Category + Recipient) — editable */}
                                <div className="md:col-span-6">
                                    <label className="block text-sm font-medium text-gray-700">Recipient *</label>

                                    {!initialRecipientKnown ? (
                                        <div className="mt-1 mb-2 rounded border border-amber-200 bg-amber-50 px3 py-2 text-xs text-amber-900">
                                            The current recipient OID isn’t in the directory. Please pick a valid recipient below to update this submission.
                                        </div>
                                    ) : null}

                                    {purposeChanged && !selectedRecipient ? (
                                        <div className="mt-1 mb-2 text-xs text-amber-700">
                                            Purpose changed — please reselect a recipient.
                                        </div>
                                    ) : null}

                                    <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
                                        {/* Category */}
                                        <select
                                            value={categoryId}
                                            onChange={e => {
                                                const raw = e.target.value.trim()
                                                setCategoryId(isRecipientCategory(raw) ? raw : '')
                                                setSelectedRecipient('')
                                            }}
                                            disabled={!purpose}
                                            className={`md:col-span-5 ${SELECT_CLS}`}
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

                                        {/* Recipient list */}
                                        <select
                                            value={selectedRecipient}
                                            onChange={e => setSelectedRecipient(e.target.value)}
                                            disabled={!categoryId || recipientOptions.length === 0}
                                            className={`md:col-span-7 ${SELECT_CLS}`}
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
                                    <ErrorList errors={fields.recipient?.errors} id={`${fields.recipient?.id ?? 'recipient'}-errors`} />
                                </div>

                                {/* NPI/Claim/Case/Comments/X12/Threshold */}
                                <div className="md:col-span-6">
                                    <SelectField labelProps={{ children: 'NPI *' }} selectProps={{ ...getSelectProps(fields.providerId), className: SELECT_CLS }} errors={fields.providerId?.errors}>
                                        {availableNpis.map((p: Npi) => (
                                            <option key={p.id} value={p.id}>
                                                {p.npi}
                                                {p.name ? ` - ${p.name}` : ''}
                                            </option>
                                        ))}
                                    </SelectField>
                                </div>

                                <div className="md:col-span-6">
                                    <Field labelProps={{ children: 'Claim ID *' }} inputProps={{ ...getInputProps(fields.claimId, { type: 'text' }), className: INPUT_CLS }} errors={fields.claimId?.errors} />
                                </div>

                                <div className="md:col-span-6">
                                    <Field labelProps={{ children: 'Case ID' }} inputProps={{ ...getInputProps(fields.caseId, { type: 'text' }), maxLength: 32, className: INPUT_CLS }} errors={fields.caseId?.errors} />
                                </div>

                                <div className="md:col-span-6">
                                    <TextareaField
                                        labelProps={{ children: 'Comments' }}
                                        textareaProps={{ ...getInputProps(fields.comments, { type: 'text' }), rows: 3, className: 'text-gray-900 placeholder-gray-400' }}
                                        errors={fields.comments?.errors}
                                    />
                                </div>

                                <div className="md:col-span-6">
                                    <SelectField labelProps={{ children: 'Send in X12' }} selectProps={{ ...getSelectProps(fields.sendInX12), className: SELECT_CLS }} errors={fields.sendInX12?.errors}>
                                        <option value="false">False</option>
                                        <option value="true">True</option>
                                    </SelectField>
                                </div>

                                <div className="md:col-span-6">
                                    <Field labelProps={{ children: 'Threshold' }} inputProps={{ ...getInputProps(fields.threshold, { type: 'number' }), min: 1, className: INPUT_CLS }} errors={fields.threshold?.errors} />
                                </div>
                            </div>
                        </div>

                        {/* ===== Split Settings ===== */}
                        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
                            <h4 className="text-sm font-semibold text-indigo-900 mb-3">Split Settings</h4>
                            <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:grid-cols-12">
                                <div className="md:col-span-6">
                                    <label className="block text-sm font-medium text-gray-700">Split kind *</label>
                                    <select
                                        name="splitKind"
                                        value={splitKind}
                                        onChange={e => setSplitKind(e.target.value as 'manual' | 'auto')}
                                        className={SELECT_CLS}
                                    >
                                        <option value="manual">Manual</option>
                                        <option value="auto">Auto</option>
                                    </select>
                                </div>

                                <div className="md:col-span-6">
                                    <label className="block text-sm font-medium text-gray-700">auto_split (derived)</label>
                                    <input
                                        type="text"
                                        readOnly
                                        value={splitKind === 'auto' ? 'true' : 'false'}
                                        className={READONLY_CLS}
                                    />
                                </div>

                                {splitKind === 'manual' ? (
                                    <div className="md:col-span-6">
                                        <label className="block text-sm font-medium text-gray-700">Number of documents *</label>
                                        <select
                                            name="docCount"
                                            value={docCount}
                                            onChange={e => setDocCount(Number(e.target.value))}
                                            className={SELECT_CLS}
                                        >
                                            {Array.from({ length: 99 }, (_, i) => i + 1).map(n => (
                                                <option key={n} value={n}>{n}</option>
                                            ))}
                                        </select>
                                    </div>
                                ) : null}
                            </div>
                        </div>

                        {/* ===== Document metadata blocks ===== */}
                        <div className="rounded-lg border border-gray-200 bg-white p-4">
                            <div className="flex items-center justify-between mb-2">
                                <h3 className="text-base font-semibold text-gray-900">Document Metadata</h3>
                                <div className="flex items-center gap-2 text-xs">
                                    <span className="inline-block rounded px-2 py-0.5 ring-1 ring-emerald-300 bg-emerald-50 text-emerald-700">
                                        Total: {totalSizeMB.toFixed(1)} / {MAX_TOTAL_MB} MB
                                    </span>
                                </div>
                            </div>

                            {Array.from({ length: splitKind === 'manual' ? docCount : 1 }).map((_, idx) => {
                                const i = idx + 1
                                const meta = docMeta[i] ?? { name: '', filename: '', attachmentControlNum: '' }
                                return (
                                    <div key={i} className="mb-4 rounded-md border border-gray-200 p-3">
                                        <div className="mb-2 text-sm font-medium text-gray-700">Document #{i}</div>

                                        {/* Dropzone writes to submission cache; upload occurs in Step 3 */}
                                        <FileDropzone
                                            key={`dz-${i}-${dzReset[i] ?? 0}`}
                                            label="Attach PDF (optional)"
                                            maxFileMB={perFileLimitFor(splitKind)}
                                            note={totalsNoteFor(splitKind)}
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
                                                <input type="text" readOnly value={i} className={READONLY_CLS} />
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
                                                />
                                            </div>

                                            <div className="md:col-span-6">
                                                <label className="block text-sm text-gray-700">Filename (.pdf) *</label>
                                                <input
                                                    name={`doc_filename_${i}`}
                                                    type="text"
                                                    value={meta.filename}
                                                    onBlur={async e => { await maybeRenameCachedFileTo(i, e.currentTarget.value.trim()) }}
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
                                                <input type="text" readOnly value="pdf" className={READONLY_CLS} />
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>

                        {/* Inline guidance to ensure users press "Update" if they changed metadata */}
                        <div className="rounded-md border border-red-500 bg-amber-50 p-3 text-sm text-amber-900">
                            <strong>Heads up:</strong> If any edits are made to the metadata, please make sure to choose "yes" from the dropdown below and click on "update submission" to update the metadata for the submission. Once updated please click on "Next" button to proceed with
                            next step (Upload documents).
                        </div>

                        {/* ===== Update + Next controls ===== */}
                        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">

                            {/* Toggle shows/hides the Update button to avoid accidental updates */}
                            <div className="md:col-span-8">
                                <label className="block text-sm font-medium text-gray-700 mb-1">Need to update submission?</label>
                                <select
                                    defaultValue="no"
                                    onChange={e => {
                                        const v = e.target.value as 'yes' | 'no'
                                        const btn = document.getElementById('update-submit-btn') as HTMLButtonElement | null
                                        const hint = document.getElementById('update-hidden-hint')
                                        if (btn) btn.style.display = v === 'yes' ? 'inline-flex' : 'none'
                                        if (hint) hint.style.display = v === 'yes' ? 'none' : 'block'
                                    }}
                                    className="block w-full md:w-72 rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 shadow-sm"
                                >
                                    <option value="no">No</option>
                                    <option value="yes">Yes</option>
                                </select>

                                <div id="update-hidden-hint" className="mt-1 text-xs text-gray-500">
                                    (Update button hidden — set “Need to update submission?” to <strong>Yes</strong> to show it)
                                </div>

                                <StatusButton
                                    id="update-submit-btn"
                                    type="submit"
                                    disabled={isUpdating}
                                    status={isUpdating ? 'pending' : 'idle'}
                                    className="mt-3 hidden rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                                >
                                    Update Submission
                                </StatusButton>
                            </div>

                            {/* Proceed to Step 3: Upload documents */}
                            <div className="md:col-span-4 md:justify-self-end">
                                <Link
                                    to={`/customer/submissions/${submission.id}/upload`}
                                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-400"
                                >
                                    Next <span aria-hidden>→</span>
                                </Link>
                            </div>
                        </div>

                        {/* Server-side form errors (Conform reply) */}
                        <ErrorList errors={actionData && 'result' in actionData ? (actionData as any).result?.error?.formErrors : []} id={form.errorId} />
                    </Form>

                    {/* Right-rail activity log */}
                    <SubmissionActivityLog events={submission.events ?? []} />
                </div>
            </Drawer>
        </>
    )
}
