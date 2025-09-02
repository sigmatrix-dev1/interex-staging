import { parseWithZod } from '@conform-to/zod'
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
    useLocation,
    type LoaderFunctionArgs,
    type ActionFunctionArgs,
} from 'react-router'
import { z } from 'zod'
import { FileDropzone } from '#app/components/file-dropzone.tsx'
import { InterexLayout } from '#app/components/interex-layout.tsx'
import { SubmissionActivityLog } from '#app/components/submission-activity-log.tsx'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { LoadingOverlay } from '#app/components/ui/loading-overlay.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'
import { pcgUploadFiles, pcgGetStatus } from '#app/services/pcg-hih.server.ts'
import { requireUserId } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { getCachedFile, subKey } from '#app/utils/file-cache.ts'
import { redirectWithToast } from '#app/utils/toast.server.ts'

type PcgEvent = { kind?: string; payload?: any }
type PcgStageSource = { responseMessage?: string | null; events?: PcgEvent[] | any[] }
function isDraftFromPCG(s: PcgStageSource) {
    const stageFromResponse = (s.responseMessage ?? '').toLowerCase()
    const stageFromEvent = ((s.events ?? []).find((e: any) => e?.kind === 'PCG_STATUS')?.payload?.stage ?? '').toLowerCase()
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
            description: 'Upload is only available while PCG stage is Draft.',
        })
    }
    if (!submission.pcgSubmissionId) {
        throw await redirectWithToast(`/customer/submissions/new`, {
            type: 'error',
            title: 'Missing submission_id',
            description: 'Create the submission first.',
        })
    }

    const metaEv = submission.events.find(e => e.kind === SubmissionEventKind.META_UPDATED) ?? submission.events.find(e => e.kind === SubmissionEventKind.DRAFT_CREATED)
    const docSet: Array<any> = Array.isArray((metaEv?.payload as any)?.document_set) ? (metaEv!.payload as any).document_set : []
    const expectedFilenames = docSet.map(d => d.filename).filter(Boolean)

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
        expectedFilenames, // array
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
        return data({ result: parsed.reply() }, { status: parsed.status === 'error' ? 400 : 200 })
    }
    const { submissionId } = parsed.value

    const submission = await prisma.submission.findUnique({ where: { id: submissionId }, include: { provider: true, events: true } })
    if (!submission) return data({ result: parsed.reply({ formErrors: ['Submission not found'] }) }, { status: 404 })
    if (!isDraftFromPCG(submission)) {
        return data({ result: parsed.reply({ formErrors: ['Files can only be uploaded to draft submissions'] }) }, { status: 400 })
    }
    if (!submission.pcgSubmissionId) {
        return data({ result: parsed.reply({ formErrors: ['Remote submission_id is not available.'] }) }, { status: 400 })
    }

    // Get expected filenames from latest meta
    const metaEv = submission.events.find(e => e.kind === SubmissionEventKind.META_UPDATED) ?? submission.events.find(e => e.kind === SubmissionEventKind.DRAFT_CREATED)
    const expected: string[] = Array.isArray((metaEv?.payload as any)?.document_set)
        ? (metaEv!.payload as any).document_set.map((d: any) => d.filename).filter(Boolean)
        : []

    // Collect files[]
    const files = (formData.getAll('files') as File[]).filter(f => f && f.size > 0)
    if (!files.length) return data({ result: parsed.reply({ formErrors: ['Please select file(s) to upload'] }) }, { status: 400 })

    // Count must match
    if (expected.length !== files.length) {
        return data(
            { result: parsed.reply({ formErrors: [`You selected ${files.length} file(s), but ${expected.length} file(s) are expected as per metadata.`] }) },
            { status: 400 },
        )
    }

    // Validate names
    const incomingNames = files.map(f => f.name)
    const missing = expected.filter(fn => !incomingNames.includes(fn))
    const extras = incomingNames.filter(fn => !expected.includes(fn))
    if (missing.length || extras.length) {
        const msgs = []
        if (missing.length) msgs.push(`Missing file(s): ${missing.join(', ')}`)
        if (extras.length) msgs.push(`Unexpected file(s): ${extras.join(', ')}`)
        return data({ result: parsed.reply({ formErrors: msgs }) }, { status: 400 })
    }

    // Validate sizes: each ≤150MB, total ≤300MB
    const bytesPerMB = 1024 * 1024
    const perFileErrors = files
        .filter(f => f.size / bytesPerMB > 150)
        .map(f => `File "${f.name}" is ${(f.size / bytesPerMB).toFixed(1)} MB (max 150 MB per file).`)
    const totalSizeMB = files.reduce((acc, f) => acc + f.size, 0) / bytesPerMB
    const totalError = totalSizeMB > 300 ? [`Total size ${totalSizeMB.toFixed(1)} MB exceeds 300 MB.`] : []
    const sizeErrors = [...perFileErrors, ...totalError]
    if (sizeErrors.length) return data({ result: parsed.reply({ formErrors: sizeErrors }) }, { status: 400 })

    // All good: upload
    try {
        const pcgResp = await pcgUploadFiles(submission.pcgSubmissionId, files)

        for (const file of files) {
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
        }

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
                message: `Uploaded ${files.length} file(s)`,
                payload: { submission_status: pcgResp?.submission_status, files: files.map(f => f.name) },
            },
        })

        // Audit: document upload success
        try {
            await prisma.auditLog.create({
                data: {
                    userId: user.id,
                    userEmail: user.email ?? null,
                    userName: user.name ?? null,
                    rolesCsv: user.roles.map(r => r.name).join(','),
                    customerId: submission.customerId ?? null,
                    action: 'SUBMISSION_UPLOAD_DOCUMENT',
                    entityType: 'SUBMISSION',
                    entityId: submissionId,
                    route: '/customer/submissions/:id/upload',
                    success: true,
                    message: `Uploaded ${files.length} document(s)`,
                    meta: { pcgSubmissionId: submission.pcgSubmissionId },
                    payload: { files: files.map(f => ({ name: f.name, size: f.size })) },
                },
            })
        } catch {}

        // Optionally pull PCG status and log it
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

            // Audit: status update success
            try {
                await prisma.auditLog.create({
                    data: {
                        userId: user.id,
                        userEmail: user.email ?? null,
                        userName: user.name ?? null,
                        rolesCsv: user.roles.map(r => r.name).join(','),
                        customerId: submission.customerId ?? null,
                        action: 'SUBMISSION_STATUS_UPDATE',
                        entityType: 'SUBMISSION',
                        entityId: submissionId,
                        route: '/customer/submissions/:id/upload',
                        success: true,
                        message: statusResp.stage ?? 'PCG status retrieved',
                        meta: { pcgSubmissionId: submission.pcgSubmissionId },
                        payload: statusResp,
                    },
                })
            } catch {}
        } catch {}

        return await redirectWithToast(`/customer/submissions`, {
            type: 'success',
            title: 'Files Uploaded',
            description: `${files.length} file(s) uploaded and submitted successfully.`,
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
            data: { submissionId, kind: 'PCG_UPLOAD_ERROR', message: e?.message?.toString?.() ?? 'Upload failed' },
        })

        // Audit: document upload failure
        try {
            await prisma.auditLog.create({
                data: {
                    userId: user.id,
                    userEmail: user.email ?? null,
                    userName: user.name ?? null,
                    rolesCsv: user.roles.map(r => r.name).join(','),
                    customerId: submission?.customerId ?? null,
                    action: 'SUBMISSION_UPLOAD_DOCUMENT',
                    entityType: 'SUBMISSION',
                    entityId: submissionId,
                    route: '/customer/submissions/:id/upload',
                    success: false,
                    message: e?.message?.toString?.() ?? 'Upload failed',
                    meta: { pcgSubmissionId: submission?.pcgSubmissionId ?? null },
                },
            })
        } catch {}

        return await redirectWithToast(`/customer/submissions/${submissionId}/upload`, {
            type: 'error',
            title: 'Upload Failed',
            description: e?.message?.toString?.() ?? 'Unable to upload files',
        })
    }
}

export default function UploadSubmission() {
    const { user, submission, expectedFilenames } = useLoaderData<typeof loader>()
    const actionData = useActionData<typeof action>()
    const nav = useNavigation()
    const navigate = useNavigate()
    const location = useLocation()
    const isUploading = nav.formData?.get('intent') === 'upload-file'

    // One dropzone per expected filename. We keep live state of picked files so we can validate.
    const [pickedFiles, setPickedFiles] = React.useState<Array<File | null>>(
        () => expectedFilenames.map(() => null),
    )

    const [mismatch, setMismatch] = React.useState<string[]>([])
    const [missing, setMissing] = React.useState<string[]>([])
    const [pickedTotalMB, setPickedTotalMB] = React.useState(0)
    const [perFileTooBig, setPerFileTooBig] = React.useState<string[]>([])
    const [ready, setReady] = React.useState(false)

    function recomputeValidations(nextFiles: Array<File | null>) {
        const BYTES_PER_MB = 1024 * 1024
        const mism: string[] = []
        const miss: string[] = []
        const tooBig: string[] = []
        let totalMB = 0

        for (let i = 0; i < expectedFilenames.length; i++) {
            const expected = expectedFilenames[i]
            const f = nextFiles[i]
            if (!f) {
                miss.push(`#${i + 1} — ${expected}`)
                continue
            }
            if (f.name !== expected) {
                mism.push(`#${i + 1}: selected "${f.name}" ≠ expected "${expected}"`)
            }
            const mb = f.size / BYTES_PER_MB
            if (mb > 150) tooBig.push(`${f.name} (${mb.toFixed(1)} MB)`)
            totalMB += mb
        }

        setMismatch(mism)
        setMissing(miss)
        setPerFileTooBig(tooBig)
        setPickedTotalMB(totalMB)
    }

    async function rebuildFromCache() {
        setReady(false)
        const next: Array<File | null> = []
        for (let i = 0; i < expectedFilenames.length; i++) {
            // position keys are 1-based in cache
            const f = await getCachedFile(subKey(submission.id, i + 1))
            next.push(f ?? null)
        }
        setPickedFiles(next)
        recomputeValidations(next)
        setReady(true)
    }

    // load initial from cache; mark as intentionally ignored promise
    React.useEffect(() => {
        void rebuildFromCache()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.key])

    const canSubmit =
        ready &&
        mismatch.length === 0 &&
        missing.length === 0 &&
        perFileTooBig.length === 0 &&
        pickedTotalMB <= 300

    return (
        <InterexLayout user={user} title="Upload & Submit" subtitle="Step 3 of 3" currentPath={`/customer/submissions/${submission.id}/upload`}>
            <LoadingOverlay
                show={Boolean(isUploading)}
                title="Uploading your files…"
                message="Please don't refresh or close this tab while we upload and submit your documents."
            />

            <Drawer
                key={`drawer-upload-${submission.id}`}
                isOpen
                onClose={() => navigate('/customer/submissions')}
                title={`Upload for: ${submission.title}`}
                size="fullscreen"
            >
                <div className="space-y-8">
                    <div className="rounded-md bg-gray-50 p-4 text-sm text-gray-700">
                        <p>We’ve pulled your files from the secure cache. You can review, replace, or attach them here, then submit.</p>
                        <div className="mt-2">
                            <strong>Expected filenames ({expectedFilenames.length}):</strong>
                            <ul className="mt-1 list-disc list-inside font-mono text-xs text-gray-700">
                                {expectedFilenames.map(n => <li key={n}>{n}</li>)}
                            </ul>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">Only PDF. Each ≤ 150 MB. Total ≤ 300 MB.</p>
                    </div>

                    {/* Upload form with one dropzone per expected file */}
                    <Form method="POST" encType="multipart/form-data" className="space-y-4">
                        <input type="hidden" name="intent" value="upload-file" />
                        <input type="hidden" name="submissionId" value={submission.id} />

                        <div className="space-y-4">
                            {expectedFilenames.map((expected, idx) => (
                                <div key={`${expected}-${idx}`} className="rounded-md border border-gray-200 bg-white p-3">
                                    <div className="mb-2 text-sm text-gray-700">
                                        <span className="font-medium">Document #{idx + 1}</span>{' '}
                                        <span className="font-mono text-xs text-gray-600">(must be named exactly: {expected})</span>
                                    </div>
                                    <FileDropzone
                                        name="files"
                                        label="Attach PDF"
                                        accept="application/pdf"
                                        note={<span className="text-xs">Expected: <code className="font-mono">{expected}</code></span>}
                                        initialFile={pickedFiles[idx] ?? null}
                                        onPick={(f) => {
                                            const next = [...pickedFiles]
                                            next[idx] = f
                                            setPickedFiles(next)
                                            recomputeValidations(next)
                                        }}
                                    />
                                </div>
                            ))}
                        </div>

                        {/* Alerts */}
                        {(mismatch.length || missing.length || perFileTooBig.length || pickedTotalMB > 300) ? (
                            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                                <div className="font-semibold mb-1">Please fix the following before submitting:</div>
                                {missing.length ? (
                                    <div className="mb-2">
                                        <div className="font-medium">Missing files:</div>
                                        <ul className="list-disc list-inside">
                                            {missing.map((m, i) => <li key={`miss-${i}`}>{m}</li>)}
                                        </ul>
                                    </div>
                                ) : null}
                                {mismatch.length ? (
                                    <div className="mb-2">
                                        <div className="font-medium">Filename mismatches:</div>
                                        <ul className="list-disc list-inside">
                                            {mismatch.map((m, i) => <li key={`mism-${i}`}>{m}</li>)}
                                        </ul>
                                        <div className="mt-1 text-xs">
                                            Ensure the selected file’s name matches exactly the expected filename shown above.
                                        </div>
                                    </div>
                                ) : null}
                                {perFileTooBig.length ? (
                                    <div className="mb-2">
                                        <div className="font-medium">Files over 150 MB:</div>
                                        <ul className="list-disc list-inside">
                                            {perFileTooBig.map((n, i) => <li key={`big-${i}`}>{n}</li>)}
                                        </ul>
                                    </div>
                                ) : null}
                                {pickedTotalMB > 300 ? <div>Total size {pickedTotalMB.toFixed(1)} MB exceeds 300 MB.</div> : null}
                                <div className="mt-3">
                                    <button
                                        type="button"
                                        onClick={() => { void rebuildFromCache() }}
                                        className="rounded-md bg-white px-3 py-1.5 text-sm font-medium text-gray-900 ring-1 ring-gray-300 hover:bg-gray-50"
                                    >
                                        Refresh from cache
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                                All good! Files match the expected names. Total: {pickedTotalMB.toFixed(1)} / 300 MB.
                            </div>
                        )}

                        <div className="flex items-center justify-between pt-4 border-t">
                            <Link
                                to={`/customer/submissions/${submission.id}/review`}
                                className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                            >
                                Back
                            </Link>

                            <StatusButton
                                type="submit"
                                disabled={!canSubmit || isUploading}
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
