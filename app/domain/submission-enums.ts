// #app/domain/submission-enums.ts
import { z } from 'zod'

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

export const formatEnum = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, s => s.toUpperCase())

/**
 * -------------------------------------------------------
 * Central Recipient Directory (human-friendly name <-> OID)
 * -------------------------------------------------------
 * Add new recipients here; dropdowns across the app will update automatically.
 */
export const RecipientDirectory = [
    {
        oid: '2.16.840.1.113883.13.34.110.1.110.5',
        name: 'MAC J5 (WPS)',
    },
    {
        oid: '2.16.840.1.113883.13.34.110.1.110.6',
        name: 'MAC J6 (WPS) - Do no select (Testing)',
    },

] as const

export type RecipientEntry = (typeof RecipientDirectory)[number]
export type RecipientOid = RecipientEntry['oid']

export const RecipientOidToName: Record<string, string> = Object.fromEntries(
    RecipientDirectory.map(r => [r.oid, r.name]),
)

export const RecipientOptions = RecipientDirectory.map(r => ({
    value: r.oid,
    label: `${r.name} (${r.oid})`,
}))

export function recipientNameForOid(oid: string | null | undefined) {
    if (!oid) return null
    return RecipientOidToName[oid] ?? null
}
