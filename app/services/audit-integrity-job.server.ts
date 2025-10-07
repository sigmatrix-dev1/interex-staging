// Periodic audit integrity verification job.
// Scans recent audit chains (subset) and logs SecurityEvents for any mismatches.
// Designed to be invoked by a scheduler (fly cron / external) or manually via an admin route.

import { verifyAllChains } from '#app/services/audit-verify.server.ts'
import { prisma } from '#app/utils/db.server.ts'

export interface RunAuditIntegrityJobOptions {
  sampleLimitPerChain?: number
  maxChainsWithEvents?: number // safety cap to avoid flooding securityEvent table
}

export interface AuditIntegrityJobResult {
  checkedChains: number
  mismatchedChains: number
  eventsCreated: number
  details: Array<{ chainKey: string; mismatchReason: string; seq: number }>
}

export async function runAuditIntegrityJob(opts: RunAuditIntegrityJobOptions = {}): Promise<AuditIntegrityJobResult> {
  const sampleLimitPerChain = opts.sampleLimitPerChain ?? 300
  const maxChainsWithEvents = opts.maxChainsWithEvents ?? 25
  const results = await verifyAllChains(sampleLimitPerChain)
  const mismatches = results.filter(r => !r.valid)
  const limited = mismatches.slice(0, maxChainsWithEvents)
  let eventsCreated = 0
  for (const m of limited) {
    const first = m.mismatches[0]
    try {
      await prisma.securityEvent.create({
        data: {
          kind: 'AUDIT_CHAIN_INTEGRITY_FAILURE',
          success: false,
            reason: first?.reason || 'UNKNOWN',
          data: {
            chainKey: m.chainKey,
            seq: first?.seq,
            mismatch: first,
          },
        },
      })
      eventsCreated++
    } catch {}
  }
  if (mismatches.length === 0) {
    try {
      await prisma.securityEvent.create({
        data: {
          kind: 'AUDIT_CHAIN_INTEGRITY_OK',
          success: true,
          data: { checkedChains: results.length },
        },
      })
    } catch {}
  }
  return {
    checkedChains: results.length,
    mismatchedChains: mismatches.length,
    eventsCreated,
    details: limited.map(m => ({ chainKey: m.chainKey, mismatchReason: m.mismatches[0]?.reason || 'UNKNOWN', seq: m.mismatches[0]?.seq || 0 })),
  }
}

// Lightweight in-memory throttle so manual spam requests don't flood events.
let lastRunAt: number | null = null
export function canRunAuditIntegrityJob(minIntervalMs = 60_000): boolean {
  if (!lastRunAt) return true
  return Date.now() - lastRunAt > minIntervalMs
}
export function markAuditIntegrityJobRun() { lastRunAt = Date.now() }
