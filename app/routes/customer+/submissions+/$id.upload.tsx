// app/routes/customer+/submissions+/$id.upload.tsx
import {parseWithZod} from "@conform-to/zod";
import { SubmissionEventKind } from '@prisma/client'
import * as React from 'react'
import { data, Form, useActionData, useLoaderData, useNavigation, Link, useNavigate, type LoaderFunctionArgs, type ActionFunctionArgs  } from 'react-router'
import { z } from 'zod'
import { FileDropzone } from '#app/components/file-dropzone.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { SubmissionActivityLog } from '#app/components/submission-activity-log.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { pcgUploadFiles, pcgGetStatus } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { getCachedFile, setCachedFile, clearCachedFile } from '#app/utils/file-cache.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'



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


const FileUploadSchema = z.object({
    intent: z.literal('upload-file'),
    submissionId: z.string().min(1, 'Submission ID is required'),
})


export async function loader({ request, params }: LoaderFunctionArgs) {
    const userId = await requireUserId(request)
    const id = params.id as string

    // 🔧 fetch the user so we can pass it to InterexLayout
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

    const submission = await prisma.submission.findFirst({
        where: { id },
        include: {
            provider: { select: { id: true, npi: true, name: true } },
            documents: { select: { id: true, fileName: true, fileSize: true, createdAt: true } },
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
            title: 'Not allowed',
            description: 'Upload is only available for while PCG stage is Draft.',
        })
    }
    if (!submission.pcgSubmissionId) {
        throw await redirectWithToast(`/customer/submissions/new`, {
            type: 'error',
            title: 'Missing submission_id',
            description: 'Create the submission first.',
        })
    }

    const metaEv = submission.events.find(e => e.kind === SubmissionEventKind.META_UPDATED)
        ?? submission.events.find(e => e.kind === SubmissionEventKind.DRAFT_CREATED)
    const expectedFilename = (metaEv?.payload as any)?.document_set?.[0]?.filename ?? null

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
        expectedFilename,
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
    const parsed = parseWithZod(formData, { schema: FileUploadSchema })
    if (parsed.status !== 'success') {
        return data(
  { result: parsed.reply() },
        { status: parsed.status === 'error' ? 400 : 200 },
        )
      }
    const { submissionId } = parsed.value

    const file = formData.get('file') as File | null
    if (!file || file.size === 0) {
        return data({ result: parsed.reply({ formErrors: ['Please select a file to upload'] }) }, { status: 400 })
    }
    if (!/\.pdf$/i.test(file.name)) {
        return data({ result: parsed.reply({ formErrors: ['Only PDF files are supported by PCG'] }) }, { status: 400 })
    }

    const sizeMB = file.size / (1024 * 1024)
    if (sizeMB > 300) {
        return data({ result: parsed.reply({ formErrors: ['Files over 300 MB are not supported by PCG'] }) }, { status: 400 })
    }

    const submission = await prisma.submission.findUnique({
        where: { id: submissionId },
        include: { provider: true, events: true },
    })
    if (!submission) return data({ result: parsed.reply({ formErrors: ['Submission not found'] }) }, { status: 404 })
    if (!isDraftFromPCG(submission)) {
        return data({ result: parsed.reply({ formErrors: ['Files can only be uploaded to draft submissions'] }) }, { status: 400 })
    }
    if (!submission.pcgSubmissionId) {
        return data({ result: parsed.reply({ formErrors: ['Remote submission_id is not available. Create step likely failed.'] }) }, { status: 400 })
    }

    // Require AutoSplit for large PDFs
    if (sizeMB >= 150 && sizeMB <= 300 && !submission.autoSplit) {
        return data(
            { result: parsed.reply({ formErrors: ['This file is ≥150MB. Please enable Auto Split in metadata (Step 1.1).'] }) },
            { status: 400 },
        )
    }

    // prefer META_UPDATED (latest), fallback to DRAFT_CREATED
    const metaEv = submission.events.find(e => e.kind === SubmissionEventKind.META_UPDATED)
        ?? submission.events.find(e => e.kind === SubmissionEventKind.DRAFT_CREATED)
    const expectedFilename = (metaEv?.payload as any)?.document_set?.[0]?.filename ?? null
    if (expectedFilename && expectedFilename !== file.name) {
        return data(
            { result: parsed.reply({ formErrors: [
                        `Selected file name "${file.name}" does not match the latest metadata filename "${expectedFilename}". ` +
                        `Update metadata in Step 2 or choose a file with the expected name.`,
                    ]}) },
            { status: 400 },
        )
    }


    try {
        const pcgResp = await pcgUploadFiles(submission.pcgSubmissionId, [file])

        await prisma.submissionDocument.create({
            data: {
                submissionId,
                fileName: file.name,
                originalFileName: file.name,
                fileSize: file.size,
                mimeType: file.type,
                uploaderId: userId,
                objectKey: `/pcg/${submission.pcgSubmissionId}/${file.name}`,
                uploadStatus: 'UPLOADED',
            },
        })

        await prisma.submission.update({
            where: { id: submissionId },
            data: {
                status: 'SUBMITTED',
                responseMessage: pcgResp?.submission_status ?? null,
                updatedAt: new Date(),
            },
        })

        await prisma.submissionEvent.create({
            data: {
                submissionId,
                kind: 'PCG_UPLOAD_SUCCESS',
                message: `Uploaded ${file.name}`,
                payload: { submission_status: pcgResp?.submission_status, file: file.name },
            },
        })

        // 🔄 Immediately fetch latest status from PCG and persist it
        try {
            const statusResp = await pcgGetStatus(submission.pcgSubmissionId!)
            await prisma.submissionEvent.create({
                data: {
                    submissionId,
                    kind: SubmissionEventKind.PCG_STATUS,
                    message: statusResp.stage ?? 'Status retrieved',
                    payload: statusResp,
                },
            })
            await prisma.submission.update({
                where: { id: submissionId },
                data: {
                    transactionId: statusResp.esmdTransactionId ?? null,
                    responseMessage: statusResp.stage ?? null,
                    updatedAt: new Date(),
                },
            })
        } catch (err) {
            // Non-fatal: keep the upload success redirect; status can be refreshed manually later
        }

        return await redirectWithToast(`/customer/submissions`, {
            type: 'success',
            title: 'File Uploaded',
            description: `${file.name} uploaded and submitted successfully.`,
        })
    } catch (e: any) {
        await prisma.submission.update({
            where: { id: submissionId },
            data: {
                status: 'ERROR',
                errorDescription: e?.message?.toString?.() ?? 'Upload failed',
                updatedAt: new Date(),
            },
        })
        await prisma.submissionEvent.create({
            data: {
                submissionId,
                kind: 'PCG_UPLOAD_ERROR',
                message: e?.message?.toString?.() ?? 'Upload failed',
            },
        })

        return await redirectWithToast(`/customer/submissions/${submissionId}/upload`, {
            type: 'error',
            title: 'Upload Failed',
            description: e?.message?.toString?.() ?? 'Unable to upload file',
        })
    }
}

export default function UploadSubmission() {
    const { user, submission, expectedFilename } = useLoaderData<typeof loader>()
    const actionData = useActionData<typeof action>()
    const nav = useNavigation()
    const navigate = useNavigate()
    const isUploading = nav.formData?.get('intent') === 'upload-file'

    const [cached, setCached] = React.useState<File | null>(null)

    // load cache on mount
    React.useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const f = await getCachedFile(submission.id)
                if (alive) setCached(f)
            } catch (err) {
                console.error(err)
            }
        })()
        return () => { alive = false }
    }, [submission.id])

// clear on unmount / nav away
    React.useEffect(() => {
        return () => { void clearCachedFile(submission.id) } // <— don't return a Promise
    }, [submission.id])

    return (
        <InterexLayout user={user} title="Upload & Submit" subtitle="Step 3 of 3" currentPath={`/customer/submissions/${submission.id}/upload`}>
            <Drawer key={`drawer-upload-${submission.id}`} isOpen onClose={() => navigate('/customer/submissions')} title={`Upload for: ${submission.title}`} size="fullscreen">
            <div className="space-y-8">
                    <div className="rounded-md bg-gray-50 p-4 text-sm text-gray-700">
                        <p>Upload the PDF to finish the submission.</p>
                        {expectedFilename ? (
                            <p className="mt-1">
                                <strong>Expected filename:</strong> <span className="font-mono">{expectedFilename}</span>
                            </p>
                        ) : (
                            <p className="mt-1">Make sure the filename matches the metadata filename you provided in Step 1.</p>
                        )}
                        <p className="mt-1 text-xs text-gray-500">Only PDF. Max 300 MB. 150–300 MB requires Auto Split On.</p>
                    </div>

                    <Form method="POST" encType="multipart/form-data" className="space-y-4">
                        <input type="hidden" name="intent" value="upload-file" />
                        <input type="hidden" name="submissionId" value={submission.id} />

                        <div>
                            <label htmlFor="file" className="block text-sm font-medium text-gray-700">
                                Select File (PDF)
                            </label>
                            <FileDropzone
                                label="Upload PDF"
                                name="file"                    // important: posts with the form
                                accept="application/pdf"
                                required
                                initialFile={cached}
                                onPick={async f => {
                                    // keep cache fresh if the user replaces the file here
                                    await setCachedFile(submission.id, f)
                                    setCached(f)
                                }}
                                note="We’ll upload this in this step. If you change the file here, make sure its name matches the metadata set in Step 2."
                            />

                            <p className="mt-1 text-xs text-gray-500">150–300 MB requires Auto Split enabled in metadata.</p>
                        </div>

                        <div className="flex items-center justify-between pt-4 border-t">
                            <Link
                                to={`/customer/submissions/${submission.id}/review`}
                                className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                            >
                                Back
                            </Link>

                            <StatusButton
                                type="submit"
                                disabled={isUploading}
                                status={isUploading ? 'pending' : 'idle'}
                                className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                            >
                                Upload & Submit
                            </StatusButton>
                        </div>

                        {actionData && 'result' in actionData && (actionData as any).result?.error?.formErrors?.length ? (
                            <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                                {(actionData as any).result.error.formErrors.map((msg: string, i: number) => (
                                    <div key={i} className="mb-1">{msg}</div>
                                ))}
                            </div>
                        ) : null}

                    </Form>

                    <SubmissionActivityLog events={submission.events ?? []} />
                </div>
            </Drawer>
        </InterexLayout>

    )

}
