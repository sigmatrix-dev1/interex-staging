// app/services/pcg-hih.server.ts
// Thin wrappers for PCG HIH Wrapper endpoints, with input mapping and robust errors.
// Uses callPcg() which auto-refreshes tokens on 401 once and logs 403 diagnostics.

import { callPcg } from '#app/services/pcg-token.server.ts'
import { PCG_ENV } from '#app/utils/env.server.ts'

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
    intended_recepient: string
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
        purpose_of_submission:
            PURPOSE_MAP[input.purposeOfSubmission] ?? input.purposeOfSubmission,
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
        document_set: input.document_set.map((d) => ({
            name: d.name,
            split_no: d.split_no,
            filename: d.filename,
            document_type: d.document_type,
            attachmentControlNum: d.attachmentControlNum,
        })),
    }
}

/** POST /pcgfhir/hih/api/submission */
export async function pcgCreateSubmission(
    payload: ReturnType<typeof buildCreateSubmissionPayload>,
) {
    const res = await callPcg(`${PCG_ENV.BASE_URL}/submission`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) {
            throw new Error(data.message)
        }
        throw new Error(
            `PCG create submission failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
    }
    return data as {
        submission_id: string
        submission_status: string
        errorList?: any[] | null
    }
}

/** POST /pcgfhir/hih/api/submission/{submission_id} with multipart "uploadFiles" (one or many) */
export async function pcgUploadFiles(submissionId: string, files: File[]) {
    const form = new FormData()
    for (const f of files) {
        form.append('uploadFiles', f, f.name)
    }
    const res = await callPcg(
        `${PCG_ENV.BASE_URL}/submission/${encodeURIComponent(submissionId)}`,
        { method: 'POST', body: form },
    )
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG upload failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
    }
    return data as {
        submission_id: string
        submission_status: string
        errorList?: any[] | null
    }
}

/** GET /pcgfhir/hih/api/submission/status/{submission_id} */
export async function pcgGetStatus(submissionId: string) {
    const res = await callPcg(
        `${PCG_ENV.BASE_URL}/submission/status/${encodeURIComponent(submissionId)}`,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    )
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG status failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
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
export function coerceStageToLocalStatus(
    stage?: string | null,
): 'SUBMITTED' | 'PROCESSING' | 'COMPLETED' {
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
    payload: ReturnType<typeof buildCreateSubmissionPayload>,
) {
    const url = `${PCG_ENV.BASE_URL}/updateSubmission/${encodeURIComponent(
        submissionId,
    )}`

    const res = await callPcg(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    })
    const text = await res.text()

    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG update submission failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
    }

    return data as { submission_id: string; errorList?: any[]; status?: string }
}

// --- User NPIs --------------------------------------------------------------

/** GET /pcgfhir/hih/api/npis  — list of NPIs registered for the org */
export async function pcgGetUserNpis() {
    const url = `${PCG_ENV.BASE_URL}/npis`
    const res = await callPcg(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG get NPIs failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
    }

    return data as {
        total: number
        pageSize: number
        page: number
        npis: string[]
    }
}

// --- Provider NPI: Create ----------------------------------------------------

/** POST /pcgfhir/hih/api/AddProviderNPI  */
export async function pcgAddProviderNpi(input: {
    providerNPI: string
    customerName: string
}) {
    const url = `${PCG_ENV.BASE_URL}/AddProviderNPI`
    const res = await callPcg(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            providerNPI: input.providerNPI,
            customerName: input.customerName,
        }),
    })
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG AddProviderNPI failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
    }

    return data as { errorList: any[]; id: string; status: string }
}

// --- Provider Management (eMDR) ---------------------------------------------

export type PcgProviderListItem = {
    errorList: any[] | null
    providerNPI: string
    last_submitted_transaction: string | null
    status_changes: any[]
    registered_for_emdr: boolean
    provider_street: string | null
    registered_for_emdr_electronic_only: boolean
    provider_state: string | null
    stage: string | null
    notificationDetails: any[]
    transaction_id_list: any[] | null
    reg_status: string | null
    provider_id: string
    provider_city: string | null
    provider_zip: string | null
    provider_name: string | null
    submission_status: string | null
    errors: any[]
    provider_street2: string | null
    esMDTransactionID: string | null
    status: string | null
}

export type PcgProviderListResponse = {
    listResponseModel: PcgProviderListItem[]
    totalResultCount: number
    totalPages: number
    pageSize: number
    page: number
}

/** GET /pcgfhir/hih/api/providers */
export async function pcgGetProviders(params?: { page?: number; pageSize?: number }) {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize))

    const url = `${PCG_ENV.BASE_URL}/providers${qs.toString() ? `?${qs.toString()}` : ''}`

    const res = await callPcg(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })

    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && (data as any)?.message) {
            throw new Error((data as any).message)
        }
        throw new Error(
            `PCG providers list failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
    }

    return data as PcgProviderListResponse
}

/** PUT /pcgfhir/hih/api/provider  (Update provider details for an NPI) */
export type PcgUpdateProviderPayload = {
    provider_name: string
    provider_npi: string
    provider_street: string
    provider_street2?: string
    provider_city: string
    provider_state: string
    provider_zip: string
}

export async function pcgUpdateProvider(payload: PcgUpdateProviderPayload) {
    const res = await callPcg(`${PCG_ENV.BASE_URL}/provider`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...payload,
            provider_street2: payload.provider_street2 ?? '',
        }),
    })
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }

    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG update provider failed (${res.status}): ${String(text).slice(0, 500) || 'Unknown error'}`,
        )
    }

    // { provider_status: "Provider Details Successfully Updated", errorList: [], provider_id: "73774" }
    return data as { provider_status: string; errorList: any[]; provider_id: string }
}

/** Register or de-register a provider for eMDR.
 *  POST /pcgfhir/hih/api/provider/{provider_id}
 *  Body: { "register_with_emdr": boolean }
 *  Returns: { registration_status: string, errorList: any[], provider_id: string }
 */
export async function pcgSetEmdrRegistration(
    providerId: string,
    registerWithEmdr: boolean,
) {
    const url = `${PCG_ENV.BASE_URL}/provider/${encodeURIComponent(providerId)}`
    const res = await callPcg(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ register_with_emdr: registerWithEmdr }),
    })
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }
    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG eMDR register/deregister failed (${res.status}): ${String(text).slice(0, 500)}`,
        )
    }
    return data as { registration_status: string; errorList: any[]; provider_id: string }
}

/** GET registration/deregistration status for a provider by provider_id.
 *  GET /pcgfhir/hih/api/provider/{provider_id}
 */
export async function pcgGetProviderRegistration(providerId: string) {
    const url = `${PCG_ENV.BASE_URL}/provider/${encodeURIComponent(providerId)}`
    const res = await callPcg(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
    })
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }
    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG get provider registration failed (${res.status}): ${String(text).slice(0, 500)}`,
        )
    }
    return data as {
        providerNPI: string
        errorList: any[]
        status_changes: any[]
        provider_street: string | null
        call_error_description: string | null
        provider_state: string | null
        stage: string | null
        transaction_id_list: string | null
        reg_status: string | null
        provider_id: string
        provider_city: string | null
        provider_zip: string | null
        provider_name: string | null
        call_error_code: string | null
        submission_status: string | null
        errors: any[]
        provider_street2: string | null
        status: string | null
    }
}

/** Register a provider for Electronic-Only ADR (must already be registered for eMDR).
 *  POST /pcgfhir/hih/api/provider/ProviderRegistrationForElectronicOnlyADR/{provider_id}
 *  Returns: { errorList: [], registration_status: "Electronic Only Submitted", provider_id: "..." }
 */
export async function pcgSetElectronicOnly(providerId: string) {
    const url = `${PCG_ENV.BASE_URL}/provider/ProviderRegistrationForElectronicOnlyADR/${encodeURIComponent(
        providerId,
    )}`
    const res = await callPcg(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    })
    const text = await res.text()
    let data: any = null
    try {
        data = text ? JSON.parse(text) : null
    } catch {
        data = text
    }
    if (!res.ok) {
        if (typeof data === 'object' && data?.message) throw new Error(data.message)
        throw new Error(
            `PCG electronic-only ADR failed (${res.status}): ${String(text).slice(0, 500)}`,
        )
    }
    return data as { errorList: any[]; registration_status: string; provider_id: string }
}

// --- eMDR Letters (lists) ----------------------------------------------------

export async function pcgListPrePayLetters(input: {
    page?: number
    startDate: string
    endDate: string
}) {
    const res = await callPcg(`${PCG_ENV.BASE_URL}/PrePayeMDR`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            page: input.page ?? 1,
            startDate: input.startDate,
            endDate: input.endDate,
        }),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok)
        throw new Error(
            `PrePayeMDR failed (${res.status}): ${String(text).slice(0, 500)}`,
        )
    return data as {
        prepayeMDRList?: any[]
        totalResultCount?: number
        errorList?: any[]
    }
}

export async function pcgListPostPayLetters(input: {
    page?: number
    startDate: string
    endDate: string
}) {
    const res = await callPcg(`${PCG_ENV.BASE_URL}/PostPayeMDR`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            page: input.page ?? 1,
            startDate: input.startDate,
            endDate: input.endDate,
        }),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok)
        throw new Error(
            `PostPayeMDR failed (${res.status}): ${String(text).slice(0, 500)}`,
        )
    return data as {
        postpayeMDRList?: any[] // some payloads use postpayeMDRList / postPayeMDRList — handle in sync layer
        postPayeMDRList?: any[]
        totalResultCount?: number
        errorList?: any[]
    }
}

export async function pcgListPostPayOtherLetters(input: {
    page?: number
    startDate: string
    endDate: string
}) {
    const res = await callPcg(`${PCG_ENV.BASE_URL}/PostPayOthereMDR`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            page: input.page ?? 1,
            startDate: input.startDate,
            endDate: input.endDate,
        }),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok)
        throw new Error(
            `PostPayOthereMDR failed (${res.status}): ${String(text).slice(0, 500)}`,
        )
    return data as {
        otherPostPayEMDRList?: any[]
        totalResultCount?: number
        errorList?: any[]
    }
}

// --- eMDR Letters (download) -------------------------------------------------

export async function pcgDownloadEmdrLetterFile(input: {
    letter_id: string
    letter_type: 'PREPAY' | 'POSTPAY' | 'POSTPAY_OTHER'
}) {
    const res = await callPcg(`${PCG_ENV.BASE_URL}/getEmdrLetterFileContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    if (!res.ok)
        throw new Error(
            `getEmdrLetterFileContent failed (${res.status}): ${String(text).slice(0, 500)}`,
        )
    return data as { file_content?: string; errorList?: any[] }
}
