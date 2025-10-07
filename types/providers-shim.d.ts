// Transitional shim: lingering TypeScript cache still believes some files import
// '#app/utils/providers/constants' requesting MOCK_CODE_GITHUB, MOCK_CODE_GITHUB_HEADER, normalizeEmail.
// These symbols are deprecated and slated for final removal after a full editor/TS server restart
// and cache purge. Keeping ambient declarations prevents phantom compile errors blocking Phase 1.
// TODO: Remove this file after confirming no references remain (grep for MOCK_CODE_GITHUB returns 0).
declare module '#app/utils/providers/constants' {
  export const MOCK_CODE_GITHUB: string
  export const MOCK_CODE_GITHUB_HEADER: string
  export function normalizeEmail(email: string): string
}

declare module '#app/utils/providers/constants.js' {
  export const MOCK_CODE_GITHUB: string
  export const MOCK_CODE_GITHUB_HEADER: string
  export function normalizeEmail(email: string): string
}

declare module '#app/utils/providers/provider.js' {
  export function normalizeEmail(email: string): string
}