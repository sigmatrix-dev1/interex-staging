// app/utils/audit-sanitize.ts
// Utility to sanitize metadata before sending to audit logging.
// Removes or normalizes fields that could be flagged as PHI by heuristic regexes.
// Specifically for letter sync actions: we only need operational date range + type list + counts.

import { sha256Hex, canonicalJson } from '#app/utils/audit-hash.ts'

export interface LetterSyncMetaInput {
  types: string[]
  startDate?: string
  endDate?: string
  rawCountByType?: Record<string, number>
}

export interface SanitizedLetterSyncMeta {
  types: string[]
  dateRange: { start: string | null; end: string | null; granularity: 'day' | 'month'; }
  counts?: Record<string, number>
  originalHash: string
  schemaVersion: 1
}

const DATE_RE = /(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])/ // matches YYYY-MM-DD etc.

function normalizeDate(value?: string): string | null {
  if (!value) return null
  const m = DATE_RE.exec(value)
  if (!m) return null
  // Down-scope to month to avoid DOB heuristic (YYYY-MM)
  const full = m[0]
  const yearMonth = full.slice(0, 7).replace(/\./g, '-').replace(/\//g, '-') // ensure separator
  return yearMonth
}

/**
 * Sanitize letter sync meta:
 * - Keep only declared fields
 * - Hash the full original meta for forensic traceability
 * - Optionally we could reduce to month granularity; add that if policy changes
 */
export function sanitizeLetterSyncMeta(input: LetterSyncMetaInput): SanitizedLetterSyncMeta {
  const originalHash = sha256Hex(canonicalJson(input))
  const start = normalizeDate(input.startDate)
  const end = normalizeDate(input.endDate)
  return {
    schemaVersion: 1 as const,
    types: input.types || [],
    dateRange: { start, end, granularity: 'month' },
    counts: input.rawCountByType && Object.keys(input.rawCountByType).length ? input.rawCountByType : undefined,
    originalHash,
  }
}
