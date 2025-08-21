// app/services/pcg-hih.server.ts
// Thin wrappers for PCG HIH Wrapper endpoints, with input mapping and robust errors.
// Uses callPcg() which auto-refreshes tokens on 401 once.

import { callPcg } from '#app/services/pcg-token.server.ts'

/** Map UI "purposeOfSubmission" (enum) -> PCG "purpose_of_submission" code strings. */
const PURPOSE_MAP: Record<string, string> = {
    ADR: '1',
    PWK_CLAIM_DOCUMENTATION: '7',
    FIRST_APPEAL: '9',
    SECOND_APPEAL: '9.1',
}

/** Build the payload expected by PCG "Create submission" from our UI form values. */
export function buildCreateSubmissionPayload(input: {
    purposeOfSubmission: string
    author_npi: string
    author_type: string
    name: string
    esMD_claim_id?: string | null
    esmd_case_id?: string | null
    comments?: string | null
    intended_recepient: string // NOTE: value should be the OID string per UX spec
    auto_split: boolean
    bSendinX12: boolean
    threshold: number
    document_set: Array<{
        name: string
        split_no: number
        filename: string
        document_type: 'pdf'
        attachmentControlNum: string
    }>
}) {
    return {
        purpose_of_submission: PURPOSE_MAP[input.purposeOfSubmission] ?? input.purposeOfSubmission,
        author_npi: input.author_npi,
        author_type: input.author_type,
        name: input.name,
        esMD_claim_id: input.esMD_claim_id ?? '',
        esmd_case_id: input.esmd_case_id ?? '',
        comments: input.comments ?? '',
        intended_recepient: input.intended_recepient, // raw OID string or user-entered value
        auto_split: input.auto_split,
        bSendinX12: input.bSendinX12,
        threshold: input.threshold,
        document_set: input.document_set.map(d => ({
            name: d.name,
            split_no: d.split_no,
            filename: d.filename,
            document_type: d.document_type,
            attachmentControlNum: d.attachmentControlNum,
        })),
    }
}

/** POST /pcgfhir/hih/api/submission */
export async function pcgCreateSubmission(payload: ReturnType<typeof buildCreateSubmissionPayload>) {
    const res = await callPcg('https://drfpimpl.cms.gov/pcgfhir/hih/api/submission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
    const text = await res.text()
    // Server sometimes returns JSON error bodies — try parsing, but tolerate plain text
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }

    if (!res.ok) {
        // Normalize errors into the documented shapes
        if (typeof data === 'object' && data?.message) {
            throw new Error(data.message)
        }
        throw new Error(`PCG create submission failed (${res.status}): ${text?.slice?.(0, 500) || 'Unknown error'}`)
    }
    return data as { submission_id: string; submission_status: string; errorList?: any[] | null }
}

/** POST /pcgfhir/hih/api/submission/{submission_id} with multipart "uploadFiles" (one or many) */
export async function pcgUploadFiles(submissionId: string, files: File[]) {
    const form = new FormData()
    // The API expects field name "uploadFiles". It supports multiple parts.
    for (const f of files) {
        form.append('uploadFiles', f, f.name)
    }
    const res = await callPcg(`https://drfpimpl.cms.gov/pcgfhir/hih/api/submission/${encodeURIComponent(submissionId)}`, {
        method: 'POST',
        body: form,
        // NOTE: fetch will set the correct multipart boundary; do NOT set Content-Type manually
    })
    const text = await res.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(`PCG upload failed (${res.status}): ${text?.slice?.(0, 500) || 'Unknown error'}`)
    }
    return data as { submission_id: string; submission_status: string; errorList?: any[] | null }
}

/** GET /pcgfhir/hih/api/submission/status/{submission_id} */
export async function pcgGetStatus(submissionId: string) {
    const res = await callPcg(`https://drfpimpl.cms.gov/pcgfhir/hih/api/submission/status/${encodeURIComponent(submissionId)}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    const text = await res.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(`PCG status failed (${res.status}): ${text?.slice?.(0, 500) || 'Unknown error'}`)
    }
    return data as {
        status: 'success' | 'error'
        stage?: string | null
        esmdTransactionId?: string | null
        statusChanges?: Array<{
            split_number?: string
            time?: string
            title?: string
            esmd_transaction_id?: string | null
            status?: string
        }>
        errorList?: any[]
        [k: string]: any
    }
}

/** Coarse status mapping from PCG "stage" to our SubmissionStatus. */
export function coerceStageToLocalStatus(stage?: string | null): 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' {
    if (!stage) return 'SUBMITTED'
    const s = stage.toLowerCase()
    if (s.includes('request accepted')) return 'SUBMITTED'
    if (s.includes('cloud object storage') || s.includes('delivery')) return 'PROCESSING'
    if (s.includes('review contractor pickup') || s.includes('pickup')) return 'COMPLETED'
    return 'PROCESSING'
}


/** PUT /pcgfhir/hih/api/updateSubmission/{submission_id} */
export async function pcgUpdateSubmission(
  submissionId: string,
      payload: ReturnType<typeof buildCreateSubmissionPayload>, // same shape as create
    ) {
      const url = `https://drfpimpl.cms.gov/pcgfhir/hih/api/updateSubmission/${encodeURIComponent(submissionId)}`

            const res = await callPcg(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
          })
      const text = await res.text()

          let data: any = null
          try { data = text ? JSON.parse(text) : null } catch { data = text }

          if (!res.ok) {
            if (typeof data === 'object' && data?.message) throw new Error(data.message)
            throw new Error(`PCG update submission failed (${res.status}): ${text?.slice?.(0, 500) || 'Unknown error'}`)
          }

          return data as { submission_id: string; errorList?: any[]; status?: string }
        }