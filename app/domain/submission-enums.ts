// #app/domain/submission-enums.ts
import { z } from 'zod'

/**
 * Purposes (business intent) → Content Type Code mapping
 * Supported CTCs: 1 (ADR), 7 (PWK), 9 (First Appeal), 9.1 (Second Appeal)
 */
export const SubmissionPurposeValues = [
    'ADR',                              // CTC 1
    'PWK_CLAIM_DOCUMENTATION',          // CTC 7 (Unsolicited PWK XDR)
    'FIRST_APPEAL',                     // CTC 9
    'SECOND_APPEAL',                    // CTC 9.1
] as const
export type SubmissionPurpose = (typeof SubmissionPurposeValues)[number]
export const SubmissionPurposeEnum = z.enum(SubmissionPurposeValues)

export const SubmissionPurposeLabels: Record<SubmissionPurpose, string> = {
    ADR: 'ADR - Additional Documentation Request',
    PWK_CLAIM_DOCUMENTATION: 'PWK Claim Documentation',
    FIRST_APPEAL: '1st Appeal',
    SECOND_APPEAL: '2nd Appeal',
}

export const SubmissionStatusValues = [
    'DRAFT',
    'SUBMITTED',
    'PROCESSING',
    'COMPLETED',
    'REJECTED',
    'ERROR',
] as const

export const AuthorTypeValues = ['institutional', 'individual'] as const
export const AuthorTypeEnum = z.enum(AuthorTypeValues)

export const formatEnum = (v: string) =>
    v.replace(/_/g, ' ').replace(/\b\w/g, s => s.toUpperCase())

/* -------------------- Content Type Codes -------------------- */
export type ContentTypeCode = '1' | '7' | '9' | '9.1'
export const PurposeToCTC: Record<SubmissionPurpose, ContentTypeCode> = {
    ADR: '1',
    PWK_CLAIM_DOCUMENTATION: '7',
    FIRST_APPEAL: '9',
    SECOND_APPEAL: '9.1',
}

/* -------------------- Recipient Categories -------------------- */
export const RecipientCategories = [
    'MAC',
    'RAC',
    'DME_MAC',
    'CERT_PERM',
    'SMRC_RRB',
    'QIC',
    'UPIC',
] as const
export type RecipientCategory = (typeof RecipientCategories)[number]

export const RecipientCategoryLabels: Record<RecipientCategory, string> = {
    MAC: 'MAC',
    RAC: 'RAC',
    DME_MAC: 'DME MAC',
    CERT_PERM: 'CERT/PERM',
    SMRC_RRB: 'SMRC/RRB',
    QIC: 'QICs (Second-level appeal only)',
    UPIC: 'UPIC',
}

/* -------------------- Directory -------------------- */
export type RecipientEntry = {
    oid: string
    name: string
    category: RecipientCategory
    accepts: ContentTypeCode[]
    disabled?: boolean
}

/** Note: OIDs in CMS table appear as `urn:oid:<oid>`; we store plain OID. */
export const RecipientDirectory: readonly RecipientEntry[] = [
    // RACs
    { oid: '2.16.840.1.113883.13.34.110.1.100.21', name: 'RAC Region 1 (Performant)', category: 'RAC', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.100.22', name: 'RAC Region 2 (Performant)', category: 'RAC', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.100.23', name: 'RAC Region 3 (Cotiviti)', category: 'RAC', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.100.24', name: 'RAC Region 4 (Cotiviti)', category: 'RAC', accepts: ['1', '7'] },
    { oid: '2.16.840.1.113883.13.34.110.1.100.25', name: 'RAC Region 5 (Cotiviti)', category: 'RAC', accepts: ['1'] },

    // MACs
    { oid: '2.16.840.1.113883.13.34.110.1.110.11', name: 'MAC JM (Palmetto)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.10', name: 'MAC JJ (Palmetto)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.12', name: 'MAC JL (Novitas Solutions)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.13', name: 'MAC JK (NGS)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.15', name: 'MAC J15 (CGS)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.16', name: 'MAC JE (Noridian)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.3',  name: 'MAC JF (Noridian)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.5',  name: 'MAC J5 (WPS)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.7',  name: 'MAC JH (Novitas Solutions)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.8',  name: 'MAC J8 (WPS)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.110.9',  name: 'MAC JN (FCSO)', category: 'MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.250.1',  name: 'MAC J6 (NGS)', category: 'MAC', accepts: ['1', '7', '9'] },

    // DME MACs
    { oid: '2.16.840.1.113883.13.34.110.1.150.1', name: 'DME MAC A (Noridian)', category: 'DME_MAC', accepts: ['1', '7', '9', '9.1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.150.2', name: 'DME MAC B (CGS)',      category: 'DME_MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.150.3', name: 'DME MAC C (CGS)',      category: 'DME_MAC', accepts: ['1', '7', '9'] },
    { oid: '2.16.840.1.113883.13.34.110.1.150.4', name: 'DME MAC D (Noridian)', category: 'DME_MAC', accepts: ['1', '7', '9'] },

    // CERT / PERM
    { oid: '2.16.840.1.113883.13.34.110.1.200.1', name: 'CERT (Empower AI)', category: 'CERT_PERM', accepts: ['1', '9', '9.1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.200.3', name: 'PERM Review Contractor (Empower AI)', category: 'CERT_PERM', accepts: ['1', '9', '9.1'] },

    // QIO (kept with CERT/PERM)
    { oid: '2.16.840.1.113883.13.34.110.1.500.12', name: 'QIO Appeals (Livanta)', category: 'CERT_PERM', accepts: ['1', '9', '9.1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.500.13', name: 'QIO Quality of Care Complaints (Livanta)', category: 'CERT_PERM', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.500.15', name: 'QIO HWDRG (Livanta)', category: 'CERT_PERM', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.500.17', name: 'QIO SSR (Livanta)', category: 'CERT_PERM', accepts: ['1'] },

    // QICs (Second-level appeals only)
    { oid: '2.16.840.1.113883.13.34.110.1.600.1', name: 'QIC Part A East (C2C)', category: 'QIC', accepts: ['9.1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.600.2', name: 'QIC Part A West (Maximus)', category: 'QIC', accepts: ['9.1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.600.3', name: 'QIC Part B North (C2C)', category: 'QIC', accepts: ['9.1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.600.4', name: 'QIC Part B South (C2C)', category: 'QIC', accepts: ['9.1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.600.6', name: 'QIC DME (Maximus)', category: 'QIC', accepts: ['9.1'] },

    // SMRC / RRB (no 9.1)
    { oid: '2.16.840.1.113883.13.34.110.1.250.2', name: 'SMRC (Noridian)', category: 'SMRC_RRB', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.400.1', name: 'RRB (Palmetto GBA)', category: 'SMRC_RRB', accepts: ['1', '7', '9'] },

    // UPICs
    { oid: '2.16.840.1.113883.13.34.110.1.700.1', name: 'UPIC NE (Safeguard Services)', category: 'UPIC', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.700.6', name: 'UPIC MW (Covent Bridge Group)', category: 'UPIC', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.700.3', name: 'UPIC SW (Qlarant)', category: 'UPIC', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.700.4', name: 'UPIC SE (Safeguard Services)', category: 'UPIC', accepts: ['1'] },
    { oid: '2.16.840.1.113883.13.34.110.1.700.5', name: 'UPIC W (Qlarant)', category: 'UPIC', accepts: ['1'] },
] as const

export type RecipientOid = RecipientEntry['oid']

/* -------------------- Lookups & helpers -------------------- */
export const RecipientOidToName: Record<string, string> = Object.fromEntries(
    RecipientDirectory.map(r => [r.oid, r.name]),
)

export function recipientNameForOid(oid: string | null | undefined) {
    if (!oid) return null
    return RecipientOidToName[oid] ?? null
}

export function getRecipientByOid(oid: string | null | undefined) {
    if (!oid) return undefined
    return RecipientDirectory.find(r => r.oid === oid)
}

export function recipientHelperLabel(oid: string | null | undefined) {
    const r = getRecipientByOid(oid)
    return r ? `${r.name} (${r.oid})` : undefined
}

/* -------------------- Filtering for UI -------------------- */
export function isRecipientAcceptingPurpose(oid: string, purpose: SubmissionPurpose) {
    const rec = RecipientDirectory.find(r => r.oid === oid)
    if (!rec) return false
    const ctc = PurposeToCTC[purpose]
    return rec.accepts.includes(ctc)
}

/** Category options for a given purpose, with disabled + hint when zero recipients. */
export function categoriesForPurpose(purpose: SubmissionPurpose) {
    const ctc = PurposeToCTC[purpose]
    return (RecipientCategories as readonly RecipientCategory[]).map(cat => {
        const count = RecipientDirectory.filter(r => r.category === cat && r.accepts.includes(ctc)).length
        const label =
            count > 0
                ? RecipientCategoryLabels[cat]
                : `${RecipientCategoryLabels[cat]} — no recipients for ${SubmissionPurposeLabels[purpose].split(' - ')[0]}`
        return { value: cat, label, disabled: count === 0, count }
    })
}

/** Recipients for a category+purpose (labels are Name only for the dropdown). */
export function recipientsFor(category: RecipientCategory, purpose: SubmissionPurpose) {
    const ctc = PurposeToCTC[purpose]
    return RecipientDirectory
        .filter(r => r.category === category && r.accepts.includes(ctc))
        .map(r => ({ value: r.oid, label: r.name }))
}

/** Convenience: which category does this OID belong to? */
export function categoryForOid(oid: string | null | undefined): RecipientCategory | null {
    const r = getRecipientByOid(oid ?? '')
    return r?.category ?? null
}

/** Legacy export (all recipients unfiltered) — kept for admin/debug */
export const RecipientOptions = RecipientDirectory
    .filter(r => !r.disabled)
    .map(r => ({ value: r.oid, label: `${r.name} (${r.oid})` }))
