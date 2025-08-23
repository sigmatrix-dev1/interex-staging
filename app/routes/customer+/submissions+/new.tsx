// app/routes/customer+/submissions+/new.tsx
import { getFormProps, getInputProps, getSelectProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { data, Form, useActionData, useLoaderData, useNavigation, Link, redirect , useNavigate, type LoaderFunctionArgs, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { FileDropzone } from '#app/components/file-dropzone.tsx'
import { Field, SelectField, TextareaField, ErrorList } from '#app/components/forms.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import {
    SubmissionPurposeValues,
    SubmissionPurposeEnum,
    AuthorTypeEnum,
    formatEnum,
} from '#app/domain/submission-enums.ts'
import { buildCreateSubmissionPayload, pcgCreateSubmission } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'



function setInputValue(input: HTMLInputElement | null | undefined, value: string) {
    if (!input) return
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
}

import { setCachedFile } from '#app/utils/file-cache.ts'

type Npi = { id: string; npi: string; name: string | null }

const CreateSubmissionSchema = z.object({
    intent: z.literal('create'),
    title: z.string().min(1, 'Title is required'),
    authorType: AuthorTypeEnum,
    purposeOfSubmission: SubmissionPurposeEnum,
    recipient: z.string().min(1, 'Recipient is required'),
    providerId: z.string().min(1, 'NPI selection is required'),
    claimId: z.string().min(1,'Claim ID is required'),
    caseId: z.string().max(32, 'Case ID cannot exceed 32 characters').optional(),
    comments: z.string().optional(),

    autoSplit: z.enum(['true', 'false']).transform(v => v === 'true'),
    sendInX12: z.enum(['true', 'false']).transform(v => v === 'true'),
    threshold: z.coerce.number().int().min(1).default(100),

    doc_name: z.string().min(1, 'Document name is required'),
    doc_split_no: z.coerce.number().int().min(1).default(1),
    doc_filename: z.string().regex(/\.pdf$/i, 'Filename must end with .pdf'),
    doc_document_type: z.literal('pdf').default('pdf'),
    doc_attachment: z.string().min(1, 'Attachment Control Number is required').default('Please specify attachment control number'),
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
        return Response.json(
        { result: parsed.reply() },
        { status: parsed.status === 'error' ? 400 : 200 },
        )
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
        autoSplit,
        sendInX12,
        threshold,
        doc_name,
        doc_split_no,
        doc_filename,
        doc_document_type,
        doc_attachment,
    } = parsed.value

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

    // Create local row (DRAFT)
    const newSubmission = await prisma.submission.create({
        data: {
            title,
            authorType,
            purposeOfSubmission,
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

    // Prepare payload to PCG & audit what we'll send
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
        document_set: [
            {
                name: doc_name,
                split_no: doc_split_no,
                filename: doc_filename,
                document_type: doc_document_type,
                attachmentControlNum: doc_attachment,
            },
        ],
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
        if (!pcgResp?.submission_id) {
            throw new Error('PCG did not return a submission_id')
        }

        await prisma.submission.update({
            where: { id: newSubmission.id },
            data: {
                pcgSubmissionId: pcgResp.submission_id,
                responseMessage: 'Draft',
                status: 'DRAFT',
            },
        })

        await prisma.submissionEvent.create({
            data: {
                submissionId: newSubmission.id,
                kind: 'PCG_CREATE_SUCCESS',
                message: `PCG submission created (id ${pcgResp.submission_id})`,
                payload: pcgResp,
            },
        })

        // go to Step‑1.1
        return await redirectWithToast(`/customer/submissions/${newSubmission.id}/review`, {
            type: 'success',
            title: 'Submission Created',
            description: 'Metadata saved. Review your data next.',
        })
    } catch (e: any) {
        await prisma.submission.update({
            where: { id: newSubmission.id },
            data: {
                status: 'ERROR',
                errorDescription: e?.message?.toString?.() ?? 'Create failed',
            },
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

    return (
        <InterexLayout user={user} title="Create Submission" subtitle="Step 1 of 3" currentPath="/customer/submissions/new">
            <Drawer key="drawer-new" isOpen onClose={() => navigate('/customer/submissions')} title="Create New Submission" size="fullscreen">
            <Form method="POST" {...getFormProps(form)} className="space-y-6">
                    <input type="hidden" name="intent" value="create" />

                    <Field
                        labelProps={{ children: 'Title *' }}
                        inputProps={{ ...getInputProps(fields.title, { type: 'text' }), placeholder: 'Enter submission title' }}
                        errors={fields.title.errors}
                    />

                    <SelectField labelProps={{ children: 'Author Type *' }} selectProps={getSelectProps(fields.authorType)} errors={fields.authorType.errors}>
                        <option value="">Select author type</option>
                        {AuthorTypeEnum.options.map(a => (
                            <option key={a} value={a}>{formatEnum(a)}</option>
                        ))}
                    </SelectField>

                    <SelectField
                        labelProps={{ children: 'Purpose of Submission *' }}
                        selectProps={getSelectProps(fields.purposeOfSubmission)}
                        errors={fields.purposeOfSubmission.errors}
                    >
                        <option value="">Select purpose</option>
                        {SubmissionPurposeValues.map(p => (
                            <option key={p} value={p}>{formatEnum(p)}</option>
                        ))}
                    </SelectField>

                    <Field
                        labelProps={{ children: 'Recipient (OID/code) *' }}
                        inputProps={{ ...getInputProps(fields.recipient, { type: 'text' }), placeholder: 'Receiving partner OID' }}
                        errors={fields.recipient.errors}
                    />

                    <SelectField labelProps={{ children: 'NPI *' }} selectProps={getSelectProps(fields.providerId)} errors={fields.providerId.errors}>
                        <option value="">Select NPI</option>
                        {availableNpis.map(p => (
                            <option key={p.id} value={p.id}>
                                {p.npi}
                                {p.name ? ` - ${p.name}` : ''}
                            </option>
                        ))}
                    </SelectField>

                    <Field
                        labelProps={{ children: 'Claim ID *' }}
                        inputProps={{ ...getInputProps(fields.claimId, { type: 'text' }) }}
                        errors={fields.claimId.errors}
                    />

                    <Field
                        labelProps={{ children: 'Case ID' }}
                        inputProps={{ ...getInputProps(fields.caseId, { type: 'text' }), placeholder: 'Up to 32 chars', maxLength: 32 }}
                        errors={fields.caseId.errors}
                    />

                    <TextareaField
                        labelProps={{ children: 'Comments' }}
                        textareaProps={{
                            ...getInputProps(fields.comments, { type: 'text' }),
                            rows: 3,
                            placeholder: 'Notes (optional)',
                            className: 'text-gray-900 placeholder-gray-400',
                        }}
                        errors={fields.comments.errors}
                    />


                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <SelectField labelProps={{ children: 'Send in X12' }} selectProps={getSelectProps(fields.sendInX12)} errors={fields.sendInX12.errors}>
                            <option value="false">False</option>
                            <option value="true">True</option>
                        </SelectField>

                        <Field
                            labelProps={{ children: 'Threshold' }}
                            inputProps={{ ...getInputProps(fields.threshold, { type: 'number' }), min: 1, placeholder: '100' }}
                            errors={fields.threshold.errors}
                        />
                    </div>

                <FileDropzone
                    accept="application/pdf"
                    onPick={f => {
                        void setCachedFile('NEW',f)
                        // doc_filename
                        setInputValue(document.getElementById(fields.doc_filename.id) as HTMLInputElement, f.name)
                        // doc_name = base name without extension
                        const base = f.name.replace(/\.pdf$/i, '')
                        setInputValue(document.getElementById(fields.doc_name.id) as HTMLInputElement, base)
                        // doc_document_type stays "pdf" (already rendered disabled with "pdf")
                        // If big file, suggest autoSplit on
                        const sizeMB = f.size / 1024 / 1024
                        if (sizeMB >= 150) {
                            setInputValue(document.getElementById(fields.autoSplit.id) as HTMLInputElement, 'true')
                        }
                    }}
                    note="Choosing a PDF here will pre-fill the document metadata fields below."
                />


                <div className="pt-2 border-t">
                        <h4 className="text-sm font-semibold text-gray-900 mb-3">Document metadata (for the first file)</h4>

                        <Field
                            labelProps={{ children: 'Document Name *' }}
                            inputProps={{ ...getInputProps(fields.doc_name, { type: 'text' }), placeholder: 'e.g., Progress Notes' }}
                            errors={fields.doc_name.errors}
                        />

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <Field
                                labelProps={{ children: 'Filename (.pdf) *' }}
                                inputProps={{ ...getInputProps(fields.doc_filename, { type: 'text' }), placeholder: 'MyDocument.pdf' }}
                                errors={fields.doc_filename.errors}
                            />
                            <Field
                                labelProps={{ children: 'Split No' }}
                                inputProps={{ ...getInputProps(fields.doc_split_no, { type: 'number' }), min: 1, defaultValue: 1}}
                                errors={fields.doc_split_no.errors}
                            />
                            <Field
                                labelProps={{ children: 'Document Type' }}
                                inputProps={{ ...getInputProps(fields.doc_document_type, { type: 'text' }), disabled: true, value: 'pdf' }}
                                errors={fields.doc_document_type.errors}
                            />
                        </div>

                        <Field
                            labelProps={{ children: 'Attachment Control Number *' }}
                            inputProps={{ ...getInputProps(fields.doc_attachment, { type: 'text' }), placeholder: 'ACN', defaultValue:'Please specify attachment control number' }}
                            errors={fields.doc_attachment.errors}
                        />

                        <div className="flex items-center gap-3 mt-2">
                            <SelectField labelProps={{ children: 'Auto Split (150–300 MB)' }} selectProps={getSelectProps(fields.autoSplit)} errors={fields.autoSplit.errors}>
                                <option value="false">False</option>
                                <option value="true">True</option>
                            </SelectField>
                            <label htmlFor="autoSplitBox" className="text-sm text-gray-700">
                                Auto Split (150–300 MB)
                            </label>
                        </div>
                    </div>

                    <div className="flex items-center justify-between pt-4 border-t">
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

                    <ErrorList errors={actionData && 'result' in actionData ? (actionData as any).result?.error?.formErrors : []} id={form.errorId} />
                </Form>
            </Drawer>
        </InterexLayout>
    )
}
