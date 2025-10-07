import { describe, it, expect, beforeEach } from 'vitest'
import { verifyChain } from '#app/services/audit-verify.server.ts'
import { logAuditEvent } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

const chainKey = 'test-chain'

describe('Audit chain continuity', () => {
  beforeEach(async () => {
    // create a few events fresh each test so we always have deterministic chain
    // (sequence numbers restart per chain because we use a constant chainKey and copy DB once)
    for (let i = 0; i < 5; i++) {
      await logAuditEvent({
        category: 'AUTH',
        action: 'LOGIN',
        actorType: 'USER',
        actorId: `user-${i}`,
        customerId: 'cust-x',
        chainKey,
        summary: 'login',
        metadata: { i },
      })
    }
  })

  it('verifies valid chain', async () => {
    const res = await verifyChain({ chainKey })
    expect(res.valid).toBe(true)
    expect(res.checked).toBeGreaterThan(0)
  })

  it('detects tampering (simulated)', async () => {
    // Simulate tampering by inserting a forged row with incorrect hashPrev linkage
    const legit = await prisma.auditEvent.findMany({ where: { chainKey }, orderBy: { seq: 'asc' } })
    expect(legit.length).toBeGreaterThan(0)
    const last = legit[legit.length - 1]!
    // Forge: next seq but wrong hashPrev (use random string)
    await prisma.$executeRawUnsafe(
      `INSERT INTO AuditEvent (id, createdAt, chainKey, seq, hashPrev, hashSelf, actorType, category, action, status) VALUES (` +
      `'forge-${Date.now()}', datetime('now'), ?, ?, ?, ?, 'SYSTEM', 'SYSTEM', 'TAMPER', 'SUCCESS')`,
      chainKey,
      last.seq + 1,
      'bogus_prev_hash',
      'bogus_self_hash'
    )
    const res = await verifyChain({ chainKey })
    expect(res.valid).toBe(false)
    expect(res.mismatches.length).toBeGreaterThan(0)
  })
})
