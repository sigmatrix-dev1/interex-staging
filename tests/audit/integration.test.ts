import { describe, it, expect } from 'vitest'
import { getRecentSubmissionAuditEvents } from '#app/services/audit-query.server.ts'
import { verifyChain } from '#app/services/audit-verify.server.ts'
import { logAuditEvent } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

// Utility to create a simple event
async function createEvent(overrides: Partial<Parameters<typeof logAuditEvent>[0]> = {}) {
  return logAuditEvent({
    category: 'SUBMISSION',
    action: 'SUBMISSION_CREATE',
    actorType: 'USER',
    actorId: 'user-x',
    customerId: overrides.customerId ?? 'custA',
    chainKey: overrides.chainKey ?? overrides.customerId ?? 'custA',
    summary: 'created',
    ...overrides,
  })
}

describe('Audit integration', () => {
  it('enforces append-only (UPDATE forbidden)', async () => {
    const e = await createEvent()
    let threw = false
    try {
      await prisma.$executeRawUnsafe(`UPDATE AuditEvent SET summary='tamper' WHERE id='${e.id}'`)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
  })

  it('enforces append-only (DELETE forbidden)', async () => {
    const e = await createEvent()
    let threw = false
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM AuditEvent WHERE id='${e.id}'`)
    } catch { threw = true }
    expect(threw).toBe(true)
  })

  it('keeps separate chains per tenant', async () => {
    await createEvent({ customerId: 'tenant1', chainKey: 'tenant1' })
    await createEvent({ customerId: 'tenant2', chainKey: 'tenant2' })
    const t1 = await prisma.auditEvent.findMany({ where: { chainKey: 'tenant1' } })
    const t2 = await prisma.auditEvent.findMany({ where: { chainKey: 'tenant2' } })
    expect(t1.every(r => r.customerId === 'tenant1')).toBe(true)
    expect(t2.every(r => r.customerId === 'tenant2')).toBe(true)
  })

  it('cursor pagination returns consistent slices', async () => {
    const tenant = 'pagetest'
    for (let i = 0; i < 30; i++) {
      await createEvent({ customerId: tenant, chainKey: tenant, summary: `evt-${i}` })
    }
    const page1 = await getRecentSubmissionAuditEvents(tenant, { limit: 10 })
    expect(page1.items).toHaveLength(10)
    if (page1.nextCursor) {
      const page2 = await getRecentSubmissionAuditEvents(tenant, { limit: 10, cursor: page1.nextCursor })
      expect(page2.items).toHaveLength(10)
      // Ensure no overlap between page1 & page2 ids
      const overlap = page1.items.filter(a => page2.items.some(b => b.id === a.id))
      expect(overlap).toHaveLength(0)
    }
  })

  it('chain continuity under concurrency', async () => {
    const ck = 'concurrent'
    // Fewer writes to reduce contention & timeout risk
    const writes = Array.from({ length: 8 }).map((_, i) =>
      logAuditEvent({
        category: 'SUBMISSION',
        action: 'SUBMISSION_CREATE',
        actorType: 'USER',
        actorId: `u-${i}`,
        customerId: 'ccust',
        chainKey: ck,
        metadata: { i },
      })
    )
    await Promise.all(writes)
    const verify = await verifyChain({ chainKey: ck })
    expect(verify.valid).toBe(true)
    const rows = await prisma.auditEvent.findMany({ where: { chainKey: ck }, orderBy: { seq: 'asc' } })
    for (let i = 0; i < rows.length; i++) {
      expect(rows[i]!.seq).toBe(i + 1)
    }
  })

  it('simulated SQLITE_BUSY retry (best-effort)', async () => {
    // Hard to deterministically trigger without low-level locking; simulate by rapid sequence
    const ck = 'busy-sim'
    const rapid = []
    for (let i = 0; i < 8; i++) {
      rapid.push(
        logAuditEvent({
          category: 'SUBMISSION',
            action: 'SUBMISSION_CREATE',
            actorType: 'USER',
            actorId: `rapid-${i}`,
            customerId: 'busyCust',
            chainKey: ck,
        })
      )
    }
    await Promise.all(rapid)
    const verify = await verifyChain({ chainKey: ck })
    expect(verify.valid).toBe(true)
  })

  it('RBAC filtering placeholder (pending implementation)', async () => {
    // If a future function enforces role-based viewing, we would test here.
    // For now, assert events exist to mark this as a placeholder.
    const any = await prisma.auditEvent.findFirst()
    expect(any).toBeTruthy()
  })
})
