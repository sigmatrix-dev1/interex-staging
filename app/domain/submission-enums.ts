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
