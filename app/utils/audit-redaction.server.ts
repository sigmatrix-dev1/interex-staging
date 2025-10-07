// app/utils/audit-redaction.server.ts
// Utilities for RBAC-based redaction of AuditEvent metadata/diff prior to serialization.
// Goal: prevent exposure of PHI / sensitive identifiers to roles below system-admin.
// Strategy: Allow list safe scalar keys; redact or mask known sensitive fields.

import { type AuditEvent } from '@prisma/client'
import { PHI_SENSITIVE_KEYS, PHI_DIFF_PATH_SUBSTRINGS, PHI_REDACTED_TOKEN, PHI_REDACTED_OBJECT_TOKEN } from './phi-constants.ts'

// Keys considered safe for non-privileged viewing (structural / technical)
const SAFE_METADATA_KEYS = new Set([
  'requestId','traceId','spanId','sessionId','ipHash','userAgent','status','attempt','chainKey','seq'
])

// Keys likely to contain PHI or sensitive info -> remove or mask
const SENSITIVE_KEYS = new Set<string>(PHI_SENSITIVE_KEYS as readonly string[])

// For diff objects we perform similar filtering
const SENSITIVE_DIFF_PATH_SUBSTRINGS = PHI_DIFF_PATH_SUBSTRINGS as readonly string[]

export interface RedactionOptions {
  isSystemAdmin: boolean
  // Future: scope limitations (customer, provider group) for multi-tenant filtering
}

function redactMetadata(meta: any): any {
  if (!meta || typeof meta !== 'object') return null
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (SAFE_METADATA_KEYS.has(k)) {
      out[k] = v
      continue
    }
    if (SENSITIVE_KEYS.has(k)) {
  out[k] = PHI_REDACTED_TOKEN
      continue
    }
    // Skip unknown keys by default (deny-by-default posture)
  }
  return out
}

function isSensitiveDiffPath(path: string) {
  const lower = path.toLowerCase()
  return SENSITIVE_DIFF_PATH_SUBSTRINGS.some(s => lower.includes(s))
}

function redactDiff(diff: any): any {
  if (!diff || typeof diff !== 'object') return null
  // Expect diff shape could be { added: {...}, removed: {...}, changed: {...} }
  const out: Record<string, any> = {}
  for (const [section, value] of Object.entries(diff)) {
    if (value && typeof value === 'object') {
      const sectionOut: Record<string, any> = {}
      for (const [k, v] of Object.entries(value as any)) {
        if (isSensitiveDiffPath(k)) {
          sectionOut[k] = PHI_REDACTED_TOKEN
        } else if (typeof v === 'object' && v !== null) {
          sectionOut[k] = PHI_REDACTED_OBJECT_TOKEN
        } else {
          sectionOut[k] = v
        }
      }
      out[section] = sectionOut
    }
  }
  return out
}

export function applyAuditRedaction<T extends Partial<AuditEvent> & { metadata?: string | null; diff?: string | null }>(
  event: T,
  opts: RedactionOptions,
): T & { metadata: string | null; diff: string | null; redacted: boolean } {
  if (opts.isSystemAdmin) {
    return { ...(event as any), redacted: false }
  }
  let parsedMeta: any = null
  let parsedDiff: any = null
  try { if (event.metadata) parsedMeta = JSON.parse(event.metadata) } catch {}
  try { if (event.diff) parsedDiff = JSON.parse(event.diff) } catch {}
  const redMeta = redactMetadata(parsedMeta)
  const redDiff = redactDiff(parsedDiff)
  return {
    ...(event as any),
    metadata: redMeta ? JSON.stringify(redMeta) : null,
    diff: redDiff ? JSON.stringify(redDiff) : null,
    redacted: true,
  }
}

export function applyBulkAuditRedaction<T extends Partial<AuditEvent> & { metadata?: string | null; diff?: string | null }>(
  events: T[],
  opts: RedactionOptions,
) {
  return events.map(e => applyAuditRedaction(e, opts))
}
