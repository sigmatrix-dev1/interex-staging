import * as React from 'react'
import { Form } from 'react-router'
import { getFormProps, getInputProps, getSelectProps, useForm } from '@conform-to/react'
import { getZodConstraint, parseWithZod } from '@conform-to/zod'
import { z } from 'zod'
import { Drawer } from '#app/components/ui/drawer.tsx'
import { Field, SelectField, TextareaField, ErrorList } from '#app/components/forms.tsx'
import { StatusButton } from '#app/components/ui/status-button.tsx'

type Npi = { id: string; npi: string; name: string | null }

/**
 * Schema used ONLY for client-side validation / UX.
 * The server-side action has its own schema (kept in sync).
 */
const CreateSubmissionSchema = z.object({
    title: z.string().min(1, 'Title is required'),
    authorType: z.enum(['institutional','individual'], { required_error: 'Author Type is required' }),
    purposeOfSubmission: z.enum([
        'ADR', 'PA_ABT', 'PA_DMEPOS', 'HH_PRE_CLAIM', 'HOPD', 'PWK_CLAIM_DOCUMENTATION',
        'FIRST_APPEAL', 'SECOND_APPEAL', 'DME_DISCUSSION', 'RA_DISCUSSION', 'ADMC', 'IRF',
    ]),
    recipient: z.string().min(1, 'Recipient is required'),
    providerId: z.string().min(1, 'NPI is required'),
    claimId: z.string().optional(),
    caseId: z.string().max(32, 'Case ID must be ≤ 32 chars').optional(),
    comments: z.string().optional(),

    // transmission
    sendInX12: z.enum(['true','false']).transform(v => v === 'true'),
    threshold: z.coerce.number().int().min(1).default(100),

    // doc metadata (Step 1 here; actual file upload happens in Step 2)
    doc_name: z.string().min(1, 'Document name is required'),
    doc_split_no: z.coerce.number().int().min(1).max(10).default(1),
    doc_filename: z.string().regex(/\.pdf$/i, 'Filename must end with .pdf'),
    doc_document_type: z.literal('pdf').default('pdf'),
    doc_attachment: z.string().min(1, 'Attachment Control Number is required'),

    autoSplit: z.boolean().default(false),

    intent: z.literal('create'),
})

type Props = {
    isOpen: boolean
    onClose: () => void
    availableNpis: Npi[]
    isPending: boolean
}

const submissionPurposes = [
    { value: 'ADR', label: 'ADR - Additional Documentation Request' },
    { value: 'PA_ABT', label: 'PA ABT - Ambulatory Services' },
    { value: 'PA_DMEPOS', label: 'PA DMEPOS - DME/Prosthetics/Orthotics' },
    { value: 'HH_PRE_CLAIM', label: 'HH Pre-Claim' },
    { value: 'HOPD', label: 'HOPD - Hospital Outpatient' },
    { value: 'PWK_CLAIM_DOCUMENTATION', label: 'PWK Claim Documentation' },
    { value: 'FIRST_APPEAL', label: '1st Appeal' },
    { value: 'SECOND_APPEAL', label: '2nd Appeal' },
    { value: 'DME_DISCUSSION', label: 'DME Discussion' },
    { value: 'RA_DISCUSSION', label: 'RA Discussion' },
    { value: 'ADMC', label: 'ADMC' },
    { value: 'IRF', label: 'IRF' },
]

export default function CreateSubmissionDrawer({ isOpen, onClose, availableNpis, isPending }: Props) {
    const [step, setStep] = React.useState<1 | 2>(1)
    const [selectedPurpose, setSelectedPurpose] = React.useState<string>('')

    const requiresClaimId = React.useMemo(
        () => ['ADR','PWK_CLAIM_DOCUMENTATION','FIRST_APPEAL','SECOND_APPEAL','DME_DISCUSSION','RA_DISCUSSION'].includes(selectedPurpose),
        [selectedPurpose],
    )

    const [form, fields] = useForm({
        id: 'create-submission',
        constraint: getZodConstraint(CreateSubmissionSchema),
        onValidate({ formData }) {
            return parseWithZod(formData, { schema: CreateSubmissionSchema })
        },
        shouldRevalidate: 'onBlur',
    })

    // helper: dropzone (UI-only)
    const fileInputRef = React.useRef<HTMLInputElement | null>(null)
    const [droppedName, setDroppedName] = React.useState<string>('')

    function onDrop(e: React.DragEvent<HTMLDivElement>) {
        e.preventDefault()
        const f = e.dataTransfer.files?.[0]
        if (!f) return
        if (!/\.pdf$/i.test(f.name)) {
            alert('Only PDF files are allowed.')
            return
        }
        setDroppedName(f.name)
        if (f.size > 300 * 1024 * 1024) {
            alert('Files over 300 MB are not supported.')
        } else if (f.size >= 150 * 1024 * 1024) {
            ;(document.querySelector<HTMLInputElement>('#autoSplitBox'))?.click()
        }
    }

    function onBrowseClick() {
        fileInputRef.current?.click()
    }
    function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
        const f = e.target.files?.[0]
        if (!f) return
        if (!/\.pdf$/i.test(f.name)) {
            alert('Only PDF files are allowed.')
            e.currentTarget.value = ''
            return
        }
        setDroppedName(f.name)
        if (f.size > 300 * 1024 * 1024) {
            alert('Files over 300 MB are not supported.')
        } else if (f.size >= 150 * 1024 * 1024) {
            ;(document.querySelector<HTMLInputElement>('#autoSplitBox'))?.click()
        }
    }

    // Keep doc_filename input synced to droppedName
    React.useEffect(() => {
        const el = document.querySelector<HTMLInputElement>('#doc_filename')
            if (el && droppedName) el.value = droppedName
            // Also auto-fill "Document Name" (base name without .pdf)
            const base = droppedName ? droppedName.replace(/\.pdf$/i,'') : ''
            const dn = document.querySelector<HTMLInputElement>('#doc_name')
            if (dn && base && !dn.value) dn.value = base
    }, [droppedName])

    return (
        <Drawer
            isOpen={isOpen}
            onClose={() => {
                setStep(1)
                onClose()
            }}
            title="Create New Submission"
            size="fullscreen"
        >
            {/* Stepper header */}
            <div className="mb-6">
                <ol className="flex items-center gap-3 text-sm">
                    <li className={`px-2 py-1 rounded ${step === 1 ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>1. Metadata</li>
                    <li className="text-gray-300">→</li>
                    <li className={`px-2 py-1 rounded ${step === 2 ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>2. Upload file</li>
                </ol>
            </div>

            <Form method="POST" {...getFormProps(form)}>
                <input type="hidden" name="intent" value="create" />

                {step === 1 ? (
                    <div className="space-y-6">
                        <Field
                            labelProps={{children: 'Title *'}}
                            inputProps={{
                                ...getInputProps(fields.title, {type: 'text'}),
                                placeholder: 'Enter submission title'
                            }}
                            errors={fields.title.errors}
                        />

                        <SelectField
                            labelProps={{children: 'Author Type *'}}
                            selectProps={getSelectProps(fields.authorType)}
                            errors={fields.authorType.errors}
                        >
                            <option value="">Select author type</option>
                            <option value="institutional">Institutional</option>
                            <option value="professional">Professional</option>
                            </SelectField>

                        <SelectField
                            labelProps={{children: 'Purpose of Submission *'}}
                            selectProps={{
                                ...getSelectProps(fields.purposeOfSubmission),
                                onChange: (e) => setSelectedPurpose(e.target.value),
                            }}
                            errors={fields.purposeOfSubmission.errors}
                        >
                            <option value="">Select purpose</option>
                            {submissionPurposes.map((p) => (
                                <option key={p.value} value={p.value}>{p.label}</option>
                            ))}
                        </SelectField>

                        <Field
                            labelProps={{children: 'Recipient *'}}
                            inputProps={{
                                ...getInputProps(fields.recipient, {type: 'text'}),
                                placeholder: 'Enter receiving partner (OID value preferred)'
                            }}
                            errors={fields.recipient.errors}
                        />

                        <SelectField
                            labelProps={{children: 'NPI *'}}
                            selectProps={getSelectProps(fields.providerId)}
                            errors={fields.providerId.errors}
                        >
                            <option value="">Select NPI</option>
                            {availableNpis.map(p => (
                                <option key={p.id} value={p.id}>{p.npi}{p.name ? ` - ${p.name}` : ''}</option>
                            ))}
                        </SelectField>

                        {requiresClaimId && (
                            <Field
                                labelProps={{children: requiresClaimId ? 'Claim ID *' : 'Claim ID'}}
                                inputProps={{
                                    ...getInputProps(fields.claimId, {type: 'text'}),
                                    placeholder: '8, 13–15, or 17–23 characters'
                                }}
                                errors={fields.claimId.errors}
                            />
                        )}

                        <Field
                            labelProps={{children: 'Case ID'}}
                            inputProps={{
                                ...getInputProps(fields.caseId, {type: 'text'}),
                                placeholder: 'Up to 32 characters (optional)',
                                maxLength: 32
                            }}
                            errors={fields.caseId.errors}
                        />

                        <TextareaField
                            labelProps={{children: 'Comments'}}
                            textareaProps={{
                                ...getInputProps(fields.comments, {type: 'text'}),
                                rows: 3,
                                placeholder: 'Notes (optional)'
                            }}
                            errors={fields.comments.errors}
                        />

                        {/* Transmission */}
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <label className="block text-sm font-semibold text-gray-900 mb-2">Send in X12</label>
                                <select
                                    {...getSelectProps(fields.sendInX12)}
                                    defaultValue="false"
                                    className="mt-1 block w-full rounded-md border border-gray-300 bg-white py-2 pl-3 pr-10 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-indigo-500"
                                >
                                    <option value="false">False</option>
                                    <option value="true">True</option>
                                </select>
                            </div>


                            <Field
                                labelProps={{children: 'Threshold'}}
                                inputProps={{
                                    ...getInputProps(fields.threshold, {type: 'number'}),
                                    placeholder: '100',
                                    min: 1
                                }}
                                errors={fields.threshold.errors}
                            />
                        </div>

                        {/* Document metadata */}
                        <div className="pt-2 border-t">
                            <h4 className="text-sm font-semibold text-gray-900 mb-3">Document metadata (for the first
                                file)</h4>

                            <Field
                                labelProps={{children: 'Document Name *'}}
                                inputProps={{
                                    ...getInputProps(fields.doc_name, {type: 'text'}),
                                    id: 'doc_name',
                                    placeholder: 'e.g. Progress Notes'
                                }}
                                errors={fields.doc_name.errors}
                            />

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <Field
                                    labelProps={{children: 'Filename (.pdf) *'}}
                                    inputProps={{
                                        ...getInputProps(fields.doc_filename, {type: 'text'}),
                                        id: 'doc_filename',
                                        placeholder: 'MyDocument.pdf'
                                    }}
                                    errors={fields.doc_filename.errors}
                                />
                                <Field
                                    labelProps={{children: 'Split No'}}
                                    inputProps={{
                                        ...getInputProps(fields.doc_split_no, {type: 'number'}),
                                        min: 1,
                                        max: 10
                                    }}
                                    errors={fields.doc_split_no.errors}
                                />
                                <Field
                                    labelProps={{children: 'Document Type'}}
                                    inputProps={{
                                        ...getInputProps(fields.doc_document_type, {type: 'text'}),
                                        disabled: true,
                                        value: 'pdf'
                                    }}
                                    errors={fields.doc_document_type.errors}
                                />
                            </div>

                            <Field
                                labelProps={{children: 'Attachment Control Number *'}}
                                inputProps={{
                                    ...getInputProps(fields.doc_attachment, {type: 'text'}),
                                    placeholder: 'Please specify attachment control number'
                                }}
                                errors={fields.doc_attachment.errors}
                            />

                            <div className="flex items-center gap-3">
                                <input {...getInputProps(fields.autoSplit, {type: 'checkbox'})} />
                                <label htmlFor="autoSplitBox" className="text-sm text-gray-700">Auto Split (150–300
                                    MB)</label>
                            </div>

                            {/* Helper dropzone (UI only) */}
                            <div
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={onDrop}
                                className="mt-4 rounded-md border border-dashed p-4 text-center text-sm text-gray-600"
                            >
                                <p className="mb-2">Drop a PDF here to pre-fill filename and check size…</p>
                                <button type="button" onClick={onBrowseClick}
                                        className="rounded border px-3 py-1 text-sm hover:bg-gray-50">
                                    Browse…
                                </button>
                                <input ref={fileInputRef} type="file" accept="application/pdf" onChange={onFileChosen}
                                       className="hidden"/>
                                {droppedName ? <p className="mt-2 text-gray-800">{droppedName}</p> : null}
                            </div>
                        </div>

                        <div className="flex items-center justify-end gap-3 pt-4 border-t">
                            <button
                                type="button"
                                onClick={onClose}
                                className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
                            >
                                Cancel
                            </button>
                            {/* Submit on Step‑1 → server creates remote submission and redirects to ?view=<id> */}
                            <StatusButton
                                type="submit"
                                disabled={isPending}
                                status={isPending ? 'pending' : 'idle'}
                                className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
                            >
                                Next
                            </StatusButton>
                        </div>


                        <ErrorList errors={form.errors} id={form.errorId}/>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="rounded-md bg-gray-50 p-4 text-sm text-gray-700">
                            <p>Upload happens after we create the submission (server will call the PCG upload API).</p>
                            <p className="mt-1">Ensure the filename matches the metadata filename you entered on the
                                previous step.</p>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Select File (PDF)</label>
                            <input type="file" accept="application/pdf" className="block w-full text-sm text-gray-500 file:mr-4 file:rounded-md file:border-0 file:bg-indigo-50 file:px-4 file:py-2 file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100" />
                            <p className="mt-1 text-xs text-gray-500">Max 300 MB. 150–300 MB requires Auto Split On.</p>
                        </div>

                        <div className="flex items-center justify-between pt-4 border-t">
                            <button type="button" onClick={() => setStep(1)} className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50">
                                Back
                            </button>
                            <div className="flex gap-3">
                                <button type="button" onClick={onClose} className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 ring-1 ring-inset ring-gray-300 hover:bg-gray-50">
                                    Cancel
                                </button>
                                <StatusButton type="submit" disabled={isPending} status={isPending ? 'pending' : 'idle'} className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
                                    Create Submission
                                </StatusButton>
                            </div>
                        </div>
                    </div>
                )}
            </Form>
        </Drawer>
    )
}
