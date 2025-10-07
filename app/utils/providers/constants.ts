// Temporary compatibility shim for legacy provider imports.
// NOTE: Phase 1 cleanup removed OAuth/provider logic. These exports remain only
// to satisfy stale generated/imported code paths until build caches are fully purged.
// Remove after confirming no references (grep for MOCK_CODE_GITHUB) post-clean build.
export const MOCK_CODE_GITHUB = ''
export const MOCK_CODE_GITHUB_HEADER = ''
export function normalizeEmail(email: string) { return email.toLowerCase() }
