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
    'PCG_ADD_PROVIDER_NPI',
    'PROVIDER_UPDATE',
    'PROVIDER_CREATE',
    'PROVIDER_TOGGLE_ACTIVE',
    'PROVIDER_DELETE',
    'PROVIDER_FETCH_REMOTE_NPIS',
    'PROVIDER_ASSIGN_USER_ATTEMPT',
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
    // Auth actions currently emitted by the app (ensure nice labels)
    'LOGIN_SUCCESS',
    'LOGIN_FAILURE',
    'LOGOUT',
    // Session management actions
    'SESSION_LOGOUT_OTHERS',
    'SESSION_REVOKE',
    'LOGOUT_OTHERS_ON_LOGIN',
    'USER_CREATE',
    'USER_CREATE_ATTEMPT',
    'USER_UPDATE',
    'USER_UPDATE_ATTEMPT',
    'USER_DELETE',
    'USER_DELETE_ATTEMPT',
    'USER_DELETE_BLOCKED',
    'USER_SET_ACTIVE',
    'USER_SET_ACTIVE_ATTEMPT',
    'USER_RESET_PASSWORD',
    'USER_RESET_PASSWORD_ATTEMPT',
    'USER_ASSIGN_NPIS',
    'USER_ASSIGN_NPIS_ATTEMPT',
    'USER_DISABLE',

    /* Admin: Provider Groups */
    'PROVIDER_GROUP_CREATE',
    'PROVIDER_GROUP_CREATE_ATTEMPT',
    'PROVIDER_GROUP_UPDATE',
    'PROVIDER_GROUP_UPDATE_ATTEMPT',
    'PROVIDER_GROUP_DELETE',
    'PROVIDER_GROUP_DELETE_ATTEMPT',
    'PROVIDER_GROUP_DELETE_BLOCKED',
    'PROVIDER_GROUP_NAME_CONFLICT',
    'PROVIDER_GROUP_NOT_FOUND',
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
    PCG_ADD_PROVIDER_NPI: 'PCG: Add Provider NPI',
    PROVIDER_UPDATE: 'Provider: Update',
    PROVIDER_CREATE: 'Provider: Create',
    PROVIDER_TOGGLE_ACTIVE: 'Provider: Toggle Active',
    PROVIDER_DELETE: 'Provider: Delete',
    PROVIDER_FETCH_REMOTE_NPIS: 'Provider: Fetch Remote NPIs',
    PROVIDER_ASSIGN_USER_ATTEMPT: 'Provider: Assign User (Attempt)',
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
    LOGIN_SUCCESS: 'Auth: Login (Success)',
    LOGIN_FAILURE: 'Auth: Login (Failure)',
    LOGOUT: 'Auth: Logout',
    SESSION_LOGOUT_OTHERS: 'Session: Sign Out Other Sessions',
    SESSION_REVOKE: 'Session: Revoke',
    LOGOUT_OTHERS_ON_LOGIN: 'Auth: Logout Others on Login',
    USER_CREATE: 'User: Create',
    USER_CREATE_ATTEMPT: 'User: Create (Attempt)',
    USER_UPDATE: 'User: Update',
    USER_UPDATE_ATTEMPT: 'User: Update (Attempt)',
    USER_DELETE: 'User: Delete',
    USER_DELETE_ATTEMPT: 'User: Delete (Attempt)',
    USER_DELETE_BLOCKED: 'User: Delete (Blocked)',
    USER_SET_ACTIVE: 'User: Set Active',
    USER_SET_ACTIVE_ATTEMPT: 'User: Set Active (Attempt)',
    USER_RESET_PASSWORD: 'User: Reset Password',
    USER_RESET_PASSWORD_ATTEMPT: 'User: Reset Password (Attempt)',
    USER_ASSIGN_NPIS: 'User: Assign NPIs',
    USER_ASSIGN_NPIS_ATTEMPT: 'User: Assign NPIs (Attempt)',
    USER_DISABLE: 'User: Disable',

    PROVIDER_GROUP_CREATE: 'Provider Group: Create',
    PROVIDER_GROUP_CREATE_ATTEMPT: 'Provider Group: Create (Attempt)',
    PROVIDER_GROUP_UPDATE: 'Provider Group: Update',
    PROVIDER_GROUP_UPDATE_ATTEMPT: 'Provider Group: Update (Attempt)',
    PROVIDER_GROUP_DELETE: 'Provider Group: Delete',
    PROVIDER_GROUP_DELETE_ATTEMPT: 'Provider Group: Delete (Attempt)',
    PROVIDER_GROUP_DELETE_BLOCKED: 'Provider Group: Delete (Blocked)',
    PROVIDER_GROUP_NAME_CONFLICT: 'Provider Group: Name Conflict',
    PROVIDER_GROUP_NOT_FOUND: 'Provider Group: Not Found',
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
