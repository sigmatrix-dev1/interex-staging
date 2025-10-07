import { createHash } from 'node:crypto'
import { z } from 'zod'
import { PHI_PATTERNS } from './phi-constants.ts'

// Max sizes (bytes) aligned with migration comments
export const AUDIT_METADATA_MAX = 2 * 1024 // 2KB
export const AUDIT_DIFF_MAX = 4 * 1024 // 4KB

// Basic schema for validating metadata & diff (loose; refined by caller)
export const AuditJsonSchema = z.any()

/** Deterministic canonical JSON stringify (sorted keys, stable arrays) */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: any): any {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortValue)
  const keys = Object.keys(value).sort()
  const out: Record<string, any> = {}
  for (const k of keys) out[k] = sortValue(value[k])
  return out
}

/** sha256 hex digest */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Compute hashSelf from the canonical representation of core fields */
export function computeAuditHashSelf(fields: {
  chainKey: string
  seq: number
  category: string
  action: string
  status: string
  actorType: string
  actorId?: string | null
  entityType?: string | null
  entityId?: string | null
  summary?: string | null
  metadata?: unknown
  diff?: unknown
  hashPrev?: string | null
}): string {
  const payload = {
    v: 1,
    chainKey: fields.chainKey,
    seq: fields.seq,
    category: fields.category,
    action: fields.action,
    status: fields.status,
    actorType: fields.actorType,
    actorId: fields.actorId ?? null,
    entityType: fields.entityType ?? null,
    entityId: fields.entityId ?? null,
    summary: fields.summary ?? null,
    metadata: fields.metadata === undefined ? null : fields.metadata,
    diff: fields.diff === undefined ? null : fields.diff,
    hashPrev: fields.hashPrev ?? null,
  }
  return sha256Hex(canonicalJson(payload))
}

// PHI detection patterns imported from unified constants file

export interface PhiScanResult {
  hasPhi: boolean
  matches: Array<{ pattern: string; sample: string }>
}

export function scanForPhi(obj: unknown): PhiScanResult {
  const text = extractText(obj)
  const matches: PhiScanResult['matches'] = []
  for (const p of PHI_PATTERNS) {
    const m = p.regex.exec(text)
    if (m) {
      matches.push({ pattern: p.name, sample: m[0] })
    }
  }
  return { hasPhi: matches.length > 0, matches }
}

function extractText(value: any): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(extractText).join(' ')
  if (typeof value === 'object') return Object.values(value).map(extractText).join(' ')
  return ''
}

export interface ValidatePayloadOptions {
  allowPhi?: boolean
  maxMetadataBytes?: number
  maxDiffBytes?: number
}

export interface ValidatedPayload {
  metadataJson?: string
  diffJson?: string
  phiDetected: boolean
}

export function validateAndSerializePayload(
  metadata: unknown,
  diff: unknown,
  opts: ValidatePayloadOptions = {}
): ValidatedPayload {
  const maxMeta = opts.maxMetadataBytes ?? AUDIT_METADATA_MAX
  const maxDiff = opts.maxDiffBytes ?? AUDIT_DIFF_MAX

  let metadataJson: string | undefined
  if (metadata !== undefined) {
    metadataJson = canonicalJson(metadata)
    if (Buffer.byteLength(metadataJson, 'utf8') > maxMeta) {
      throw new Error(`metadata exceeds ${maxMeta} bytes`)
    }
  }
  let diffJson: string | undefined
  if (diff !== undefined) {
    diffJson = canonicalJson(diff)
    if (Buffer.byteLength(diffJson, 'utf8') > maxDiff) {
      throw new Error(`diff exceeds ${maxDiff} bytes`)
    }
  }

  const phiScan = scanForPhi({ metadata, diff })
  if (phiScan.hasPhi && !opts.allowPhi) {
    throw new Error(
      `Potential PHI detected in audit payload: ${phiScan.matches
        .map((m) => m.pattern)
        .join(', ')}`
    )
  }

  return { metadataJson, diffJson, phiDetected: phiScan.hasPhi }
}
