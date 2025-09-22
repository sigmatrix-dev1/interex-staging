import { describe, it, expect } from 'vitest'
import { verifyChain } from '#app/services/audit-verify.server.ts'
import { logAuditEvent } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

/**
 * Lightweight performance & integrity smoke test.
 * Not a rigorous benchmark – just ensures we can insert N events quickly
 * and the resulting chain verifies.
 */

describe('Audit performance smoke', () => {
  it('writes 500 events under a soft time budget and verifies chain', async () => {
    const N = 500
    const chainKey = `perf-${Date.now()}`
    const t0 = performance.now()
    for (let i = 0; i < N; i++) {
      await logAuditEvent({
        category: 'SYSTEM',
        action: 'PERF_SMOKE',
        actorType: 'SYSTEM',
        chainKey,
        customerId: 'perfCust',
        summary: `perf-${i}`,
        metadata: { i },
      })
    }
    const t1 = performance.now()
    const elapsedMs = t1 - t0

    // Soft budget: < 4000ms (4ms/event avg). Adjust if environment slower.
    // We don't fail hard if occasionally slower; allow generous ceiling.
    expect(elapsedMs).toBeLessThan(8000)

    const verify = await verifyChain({ chainKey })
    expect(verify.valid).toBe(true)
    expect(verify.checked).toBe(N)

    // Basic sanity: sequence contiguous
    const rows = await prisma.auditEvent.findMany({ where: { chainKey }, orderBy: { seq: 'asc' } })
    expect(rows).toHaveLength(N)
    rows.forEach((r, idx) => expect(r.seq).toBe(idx + 1))
    // Log (console) a quick perf summary for dev visibility (not asserted)
    // Average time per event
    const avg = elapsedMs / N
    console.log(`[audit-smoke] Inserted ${N} events in ${elapsedMs.toFixed(1)}ms (avg ${(avg).toFixed(2)} ms/event)`)    
  })
})
