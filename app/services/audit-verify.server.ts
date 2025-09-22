// app/services/audit-verify.server.ts
// Chain verification utilities for AuditEvent.
// Recomputes hashSelf from canonical fields and ensures hashPrev linkage.

import { computeAuditHashSelf } from '#app/utils/audit-hash.ts'
import { prisma } from '#app/utils/db.server.ts'

export interface ChainVerifyOptions {
  chainKey: string
  fromSeq?: number
  toSeq?: number
  limit?: number // safety cap for very large chains (default 10_000)
  includePayload?: boolean // if true, parse metadata/diff JSON for mismatch diagnostics
}

export interface ChainVerifyResult {
  chainKey: string
  fromSeq: number
  toSeq: number
  checked: number
  valid: boolean
  firstSeq?: number
  lastSeq?: number
  mismatches: Array<{
    seq: number
    id: string
    reason: string
    expectedHashSelf?: string
    actualHashSelf?: string
    expectedPrev?: string | null
    actualPrev?: string | null
  }>
}

/**
 * Verify a contiguous segment (or entire chain) for a chainKey.
 * Algorithm:
 * 1. Fetch rows ordered by seq ASC within [fromSeq,toSeq] (or full range).
 * 2. For each row, recompute hashSelf from canonical fields & prior hashSelf.
 * 3. Compare stored hashPrev/hashSelf.
 * 4. Collect mismatches; early exit on first mismatch unless includePayload wants full scan.
 */
export async function verifyChain(opts: ChainVerifyOptions): Promise<ChainVerifyResult> {
  const limit = Math.min(10000, Math.max(1, opts.limit ?? 10000))
  const where: any = { chainKey: opts.chainKey }
  if (opts.fromSeq || opts.toSeq) {
    where.seq = {}
    if (opts.fromSeq) where.seq.gte = opts.fromSeq
    if (opts.toSeq) where.seq.lte = opts.toSeq
  }
  const rows = await prisma.auditEvent.findMany({
    where,
    orderBy: { seq: 'asc' },
    take: limit,
  })
  if (rows.length === 0) {
    return {
      chainKey: opts.chainKey,
      fromSeq: opts.fromSeq ?? 1,
      toSeq: opts.toSeq ?? 0,
      checked: 0,
      valid: true,
      mismatches: [],
    }
  }

  let prevHash: string | null = null
  const mismatches: ChainVerifyResult['mismatches'] = []
  for (const r of rows) {
    // Verify linkage
    if (r.hashPrev !== prevHash) {
      mismatches.push({
        seq: r.seq,
        id: r.id,
        reason: 'hashPrev mismatch',
        expectedPrev: prevHash,
        actualPrev: r.hashPrev,
      })
      if (!opts.includePayload) break
    }
    // Recompute hashSelf
    const metadataParsed = r.metadata ? safeParse(r.metadata) : undefined
    const diffParsed = r.diff ? safeParse(r.diff) : undefined
    const recomputed = computeAuditHashSelf({
      chainKey: r.chainKey,
      seq: r.seq,
      category: r.category,
      action: r.action,
      status: r.status,
      actorType: r.actorType,
      actorId: r.actorId ?? null,
      entityType: r.entityType ?? null,
      entityId: r.entityId ?? null,
      summary: r.summary ?? null,
      metadata: metadataParsed,
      diff: diffParsed,
      hashPrev: r.hashPrev ?? null,
    })
    if (recomputed !== r.hashSelf) {
      mismatches.push({
        seq: r.seq,
        id: r.id,
        reason: 'hashSelf mismatch',
        expectedHashSelf: recomputed,
        actualHashSelf: r.hashSelf,
        expectedPrev: r.hashPrev ?? null,
        actualPrev: r.hashPrev ?? null,
      })
      if (!opts.includePayload) break
    }
    prevHash = r.hashSelf
  }

  const firstSeq = rows[0]!.seq
  const lastSeq = rows[rows.length - 1]!.seq
  return {
    chainKey: opts.chainKey,
    fromSeq: opts.fromSeq ?? firstSeq,
    toSeq: opts.toSeq ?? lastSeq,
    checked: rows.length,
    valid: mismatches.length === 0,
    firstSeq,
    lastSeq,
    mismatches,
  }
}

function safeParse(s: string) {
  try { return JSON.parse(s) } catch { return undefined }
}

/** Quick helper to produce an integrity summary across all active chains (distinct chainKey). */
export async function verifyAllChains(sampleLimitPerChain = 500): Promise<Array<ChainVerifyResult>> {
  // Distinct chain keys (SQLite: manual query). Prisma doesn't have distinct on all versions; fallback to raw.
  const rows = await prisma.$queryRawUnsafe<Array<{ chainKey: string }>>('SELECT DISTINCT chainKey FROM AuditEvent LIMIT 1000')
  const results: ChainVerifyResult[] = []
  for (const r of rows) {
    const subset = await prisma.auditEvent.findMany({
      where: { chainKey: r.chainKey },
      orderBy: { seq: 'asc' },
      take: sampleLimitPerChain,
    })
    if (subset.length === 0) continue
    let prev: string | null = null
    let mismatch: ChainVerifyResult['mismatches'][number] | undefined
    for (const ev of subset) {
      if (ev.hashPrev !== prev) {
        mismatch = { seq: ev.seq, id: ev.id, reason: 'hashPrev mismatch', expectedPrev: prev, actualPrev: ev.hashPrev }
        break
      }
      const meta = ev.metadata ? safeParse(ev.metadata) : undefined
      const diff = ev.diff ? safeParse(ev.diff) : undefined
      const recomputed = computeAuditHashSelf({
        chainKey: ev.chainKey,
        seq: ev.seq,
        category: ev.category,
        action: ev.action,
        status: ev.status,
        actorType: ev.actorType,
        actorId: ev.actorId ?? null,
        entityType: ev.entityType ?? null,
        entityId: ev.entityId ?? null,
        summary: ev.summary ?? null,
        metadata: meta,
        diff: diff,
        hashPrev: ev.hashPrev ?? null,
      })
      if (recomputed !== ev.hashSelf) {
        mismatch = { seq: ev.seq, id: ev.id, reason: 'hashSelf mismatch', expectedHashSelf: recomputed, actualHashSelf: ev.hashSelf }
        break
      }
      prev = ev.hashSelf
    }
    const first = subset[0]!
    const last = subset[subset.length - 1]!
    results.push({
      chainKey: r.chainKey,
      fromSeq: first.seq,
      toSeq: last.seq,
      checked: subset.length,
      valid: !mismatch,
      firstSeq: first.seq,
      lastSeq: last.seq,
      mismatches: mismatch ? [mismatch] : [],
    })
  }
  return results
}
