import { prisma } from '#app/utils/db.server.ts'
import { verifyChain } from './audit-verify.server.ts'

/**
 * Archive Strategy (Scaffold):
 *
 * 1. Select oldest N events older than a retention cutoff (e.g., 90 days)
 * 2. Copy them into AuditEventArchive (preserving original ids / hashes / seq)
 * 3. (Optional future) Verify a segment chain hash before deletion
 * 4. Delete originals inside a single transaction to avoid partial moves
 * 5. Record an ADMIN/SYSTEM audit event summarizing archival batch
 *
 * NOTE: We already have the `AuditEventArchive` model in schema.
 */

export interface ArchiveOptions {
  beforeDate: Date
  limit?: number // safety cap per batch (default 500)
  chainKey?: string // optional restrict to a specific tenant chain
  dryRun?: boolean // if true, returns counts without modifying data
  verify?: boolean // if true, verifies chain continuity for moved segment
}

export interface ArchiveResult {
  chainKey?: string
  scanned: number
  moved: number
  deleted: number
  dryRun: boolean
  fromSeq?: number
  toSeq?: number
  verified?: boolean
}

export async function archiveOldAuditEvents(options: ArchiveOptions): Promise<ArchiveResult> {
  const limit = options.limit ?? 500
  const where: any = { createdAt: { lt: options.beforeDate } }
  if (options.chainKey) where.chainKey = options.chainKey

  // Fetch candidate rows oldest-first for deterministic segments
  const candidates = await prisma.auditEvent.findMany({
    where,
    orderBy: { seq: 'asc' },
    take: limit,
  })
  if (candidates.length === 0) {
    return { scanned: 0, moved: 0, deleted: 0, dryRun: !!options.dryRun }
  }

  const chainKey = options.chainKey ?? candidates[0]?.chainKey
  const fromSeq = candidates[0]?.seq
  const toSeq = candidates[candidates.length - 1]?.seq

  if (options.dryRun) {
    return { chainKey, scanned: candidates.length, moved: 0, deleted: 0, dryRun: true, fromSeq, toSeq }
  }

  // Execute archive move in a transaction
  return prisma.$transaction(async (tx) => {
    // Bulk insert into archive (using createMany for speed)
    await tx.auditEventArchive.createMany({
      data: candidates.map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        chainKey: c.chainKey,
        seq: c.seq,
        hashPrev: c.hashPrev,
        hashSelf: c.hashSelf,
        actorType: c.actorType,
        actorId: c.actorId,
        actorDisplay: c.actorDisplay,
        actorIp: c.actorIp,
        actorUserAgent: c.actorUserAgent,
        customerId: c.customerId,
        category: c.category,
        action: c.action,
        status: c.status,
        entityType: c.entityType,
        entityId: c.entityId,
        requestId: c.requestId,
        traceId: c.traceId,
        spanId: c.spanId,
        summary: c.summary,
        message: c.message,
        metadata: c.metadata,
        diff: c.diff,
        phi: c.phi,
        reserved1: c.reserved1,
        reserved2: c.reserved2,
      })),
    })

    // Delete originals
    const ids = candidates.map((c) => c.id)
    const deleted = await tx.auditEvent.deleteMany({ where: { id: { in: ids } } })

    // Optional verification (post-move) ensures archive has contiguous segment
    let verified: boolean | undefined
    if (options.verify) {
      const verify = await verifyChain({ chainKey: chainKey! })
      verified = verify.valid
    }

    return {
      chainKey,
      scanned: candidates.length,
      moved: candidates.length,
      deleted: deleted.count,
      dryRun: false,
      fromSeq,
      toSeq,
      verified,
    }
  })
}

/**
 * High-level scheduler hook (placeholder). In production integrate with
 * cron / worker. For now, exported for manual invocation.
 */
export async function runArchiveJob() {
  const cutoff = new Date(Date.now() - 90 * 24 * 3600_000) // 90 days
  return archiveOldAuditEvents({ beforeDate: cutoff, limit: 500, verify: false })
}
