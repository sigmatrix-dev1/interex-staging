// Periodic SecurityEvent digest job.
// Computes a deterministic hash over a time window (default: previous UTC day)
// and appends an AuditEvent summarizing counts + terminal hash so later tampering
// of individual SecurityEvent rows is detectable (hash comparison drift).
//
// Strategy:
// 1. Select SecurityEvent rows in [start,end) ordered by createdAt, id.
// 2. For each row, build a canonical JSON subset (exclude volatile fields if any emerge later).
// 3. Feed into rolling hash: sha256(prevHash + '\n' + jsonLine).
// 4. Produce final digest object: { from, to, count, hash, firstId, lastId }.
// 5. Store as AuditEvent with chainKey SECURITY_EVENT_DIGEST (one sequential chain).
// 6. Also emit a SecurityEvent kind SECURITY_EVENT_DIGEST_RECORDED for observability.
//
// If no events in the window, we still write an AuditEvent with count=0 (enables gap detection).
// Safety: idempotent for a given (from,to) range by checking if an AuditEvent already exists with summary hash.

import { createHash } from 'node:crypto'
import { computeAuditHashSelf } from '#app/utils/audit-hash.ts'
import { prisma } from '#app/utils/db.server.ts'

export interface SecurityEventDigestJobOptions {
  // By default we digest the previous UTC day. Callers can override for on-demand ranges.
  from?: Date
  to?: Date
  // Cap on rows pulled to avoid runaway memory; if exceeded we cut off and note truncated.
  maxRows?: number
  // If true and existing digest for (from,to) range exists, skip generating a duplicate.
  skipIfExists?: boolean
}

export interface SecurityEventDigestResult {
  from: Date
  to: Date
  count: number
  hash: string
  firstId?: string
  lastId?: string
  truncated: boolean
  created: boolean // whether a new AuditEvent was persisted
}

// In-memory throttle to avoid accidental rapid re-runs (e.g., manual button spam)
let lastRunAt: number | null = null
export function canRunSecurityEventDigest(minIntervalMs = 60_000) {
  return !lastRunAt || Date.now() - lastRunAt > minIntervalMs
}
export function markSecurityEventDigestRun() { lastRunAt = Date.now() }

export async function runSecurityEventDigestJob(opts: SecurityEventDigestJobOptions = {}): Promise<SecurityEventDigestResult> {
  const now = new Date()
  let from: Date
  let to: Date
  if (opts.from && opts.to) {
    from = opts.from
    to = opts.to
  } else {
    // Previous UTC day window [00:00, 24:00)
    const y = now.getUTCFullYear()
    const m = now.getUTCMonth()
    const d = now.getUTCDate()
    to = new Date(Date.UTC(y, m, d)) // today 00:00 UTC
    from = new Date(to.getTime() - 24 * 60 * 60 * 1000) // yesterday 00:00 UTC
  }
  const maxRows = opts.maxRows ?? 50_000

  // Check if digest already exists (approximate by searching AuditEvent chain with summary from/to hash).
  if (opts.skipIfExists) {
    const existing = await prisma.auditEvent.findFirst({
      where: { chainKey: 'SECURITY_EVENT_DIGEST', summary: { contains: from.toISOString().slice(0, 10) } },
      orderBy: { seq: 'desc' },
    })
    if (existing && existing.summary?.includes(from.toISOString()) && existing.summary?.includes(to.toISOString())) {
      return {
        from,
        to,
        count: 0,
        hash: 'SKIPPED',
        truncated: false,
        created: false,
      }
    }
  }

  const rows = await prisma.securityEvent.findMany({
    where: { createdAt: { gte: from, lt: to } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: maxRows + 1, // fetch sentinel row to detect truncation
  })
  const truncated = rows.length > maxRows
  if (truncated) rows.splice(maxRows) // drop extras beyond cap

  const hash = createHash('sha256')
  let firstId: string | undefined
  let lastId: string | undefined
  for (const r of rows) {
    if (!firstId) firstId = r.id
    lastId = r.id
    // Canonical minimal subset; avoid fields likely to change retroactively.
    const line = JSON.stringify({
      id: r.id,
      t: r.createdAt.toISOString(),
      k: r.kind,
      s: r.success ? 1 : 0,
      u: r.userId ?? null,
      c: r.customerId ?? null,
      r: r.reason ?? null,
    })
    hash.update(line + '\n')
  }
  const digest = hash.digest('hex')

  // Build AuditEvent chain entry.
  // Determine next seq & hashPrev from tail (if any) for chainKey SECURITY_EVENT_DIGEST.
  const tail = await prisma.auditEvent.findFirst({
    where: { chainKey: 'SECURITY_EVENT_DIGEST' },
    orderBy: { seq: 'desc' },
  })
  const nextSeq = (tail?.seq ?? 0) + 1
  const hashPrev = tail?.hashSelf ?? null
  const summary = `SECURITY_EVENT_DIGEST ${from.toISOString()} -> ${to.toISOString()} count=${rows.length}${truncated ? ' TRUNCATED' : ''}`
  const metadata = {
    from: from.toISOString(),
    to: to.toISOString(),
    count: rows.length,
    truncated,
    firstId,
    lastId,
    hash: digest,
  }

  // Compute hashSelf using existing audit hashing utility for consistency.
  const hashSelf = computeAuditHashSelf({
    chainKey: 'SECURITY_EVENT_DIGEST',
    seq: nextSeq,
    category: 'SECURITY' as any,
    action: 'SECURITY_EVENT_DIGEST',
    status: 'SUCCESS' as any,
    actorType: 'SYSTEM' as any,
    actorId: null,
    entityType: null,
    entityId: null,
    summary,
    metadata,
    diff: null,
    hashPrev,
  })

  let created = false
  try {
    await prisma.auditEvent.create({
      data: {
        chainKey: 'SECURITY_EVENT_DIGEST',
        seq: nextSeq,
        hashPrev,
        hashSelf,
        category: 'SECURITY',
        action: 'SECURITY_EVENT_DIGEST',
        status: 'SUCCESS',
        actorType: 'SYSTEM',
        summary,
        metadata: JSON.stringify(metadata),
      },
    })
    created = true
  } catch {}

  try {
    await prisma.securityEvent.create({
      data: {
        kind: 'SECURITY_EVENT_DIGEST_RECORDED',
        success: true,
        data: metadata as any,
      },
    })
  } catch {}

  return { from, to, count: rows.length, hash: digest, firstId, lastId, truncated, created }
}
