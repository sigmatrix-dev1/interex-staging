import { z } from 'zod'

/**
 * ---------- ACTIONS ----------
 * Name them as VERB_OBJECT. Keep them flat & explicit so querying is easy.
 * You can prune later if you prefer fewer verbs.
 */
export const AuditActionValues = [
    /* Letters / sync */
    'LETTERS_SYNC',
    'LETTER_DOWNLOAD',

    /* Providers / PCG / eMDR (Phase 2) */
    'PCG_FETCH',
    'PROVIDER_UPDATE',
    'REG_FETCH',
    'EMDR_REGISTER',
    'EMDR_DEREGISTER',
    'EMDR_ELECTRONIC_ONLY',

    /* Provider NPI lifecycle */
    'PROVIDER_NPI_ADD',          // create Provider row or attach a new NPI to a customer/group
    'PROVIDER_NPI_REMOVE',       // remove an NPI from a customer/group
    'PROVIDER_NPI_ASSIGN_USER',  // assign NPI -> user
    'PROVIDER_NPI_UNASSIGN_USER',
    'PROVIDER_NPI_ACTIVATE',
    'PROVIDER_NPI_DEACTIVATE',

    /* Submissions lifecycle */
    'SUBMISSION_CREATE',
    'SUBMISSION_UPDATE',
    'SUBMISSION_UPLOAD_DOCUMENT',
    'SUBMISSION_REMOVE_DOCUMENT',
    'SUBMISSION_STATUS_UPDATE',
    'SUBMISSION_DELETE',

    /* Optional: user & auth events (handy for later) */
    'AUTH_LOGIN',
    'AUTH_LOGOUT',
    'USER_CREATE',
    'USER_UPDATE',
    'USER_DISABLE',
] as const
export type AuditAction = (typeof AuditActionValues)[number]
export const AuditActionEnum = z.enum(AuditActionValues)

/**
 * ---------- ENTITIES ----------
 * Keep entities coarse enough for reuse, specific enough for filtering.
 */
export const AuditEntityValues = [
    'LETTER',
    'PROVIDER',
    'PROVIDER_NPI',   // when you specifically operate on the NPI assignment object
    'SUBMISSION',
    'DOCUMENT',       // attached to a submission
    'USER',
    'CUSTOMER',
    'PROVIDER_GROUP',
] as const
export type AuditEntity = (typeof AuditEntityValues)[number]
export const AuditEntityEnum = z.enum(AuditEntityValues)

/**
 * ---------- LABEL HELPERS (optional) ----------
 * For chips/table headings. You can customize without touching the DB.
 */
export const AuditActionLabels: Record<AuditAction, string> = {
    LETTERS_SYNC: 'Letters: Sync',
    LETTER_DOWNLOAD: 'Letter: Download',

    PCG_FETCH: 'PCG: Fetch Providers',
    PROVIDER_UPDATE: 'Provider: Update',
    REG_FETCH: 'eMDR: Fetch Registration',
    EMDR_REGISTER: 'eMDR: Register',
    EMDR_DEREGISTER: 'eMDR: Deregister',
    EMDR_ELECTRONIC_ONLY: 'eMDR: Set Electronic Only',

    PROVIDER_NPI_ADD: 'Provider NPI: Add',
    PROVIDER_NPI_REMOVE: 'Provider NPI: Remove',
    PROVIDER_NPI_ASSIGN_USER: 'Provider NPI: Assign User',
    PROVIDER_NPI_UNASSIGN_USER: 'Provider NPI: Unassign User',
    PROVIDER_NPI_ACTIVATE: 'Provider NPI: Activate',
    PROVIDER_NPI_DEACTIVATE: 'Provider NPI: Deactivate',

    SUBMISSION_CREATE: 'Submission: Create',
    SUBMISSION_UPDATE: 'Submission: Update',
    SUBMISSION_UPLOAD_DOCUMENT: 'Submission: Upload Document',
    SUBMISSION_REMOVE_DOCUMENT: 'Submission: Remove Document',
    SUBMISSION_STATUS_UPDATE: 'Submission: Update Status',
    SUBMISSION_DELETE: 'Submission: Delete',

    AUTH_LOGIN: 'Auth: Login',
    AUTH_LOGOUT: 'Auth: Logout',
    USER_CREATE: 'User: Create',
    USER_UPDATE: 'User: Update',
    USER_DISABLE: 'User: Disable',
}

export const AuditEntityLabels: Record<AuditEntity, string> = {
    LETTER: 'Letter',
    PROVIDER: 'Provider',
    PROVIDER_NPI: 'Provider NPI',
    SUBMISSION: 'Submission',
    DOCUMENT: 'Document',
    USER: 'User',
    CUSTOMER: 'Customer',
    PROVIDER_GROUP: 'Provider Group',
}

/** Safe label accessors */
export const actionLabel = (a: string | null | undefined) =>
    (a && (AuditActionLabels as any)[a]) || a || '—'

export const entityLabel = (e: string | null | undefined) =>
    (e && (AuditEntityLabels as any)[e]) || e || '—'
