import { describe, it, expect, beforeAll } from 'vitest'
import { verifyChain } from '#app/services/audit-verify.server.ts'
import { logAuditEvent } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

const chainKey = 'test-chain'

describe('Audit chain continuity', () => {
  beforeAll(async () => {
    // create a few events
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
    // Directly mutate one row's metadata to break hash
    const row = await prisma.auditEvent.findFirst({ where: { chainKey, seq: 3 } })
    expect(row).toBeTruthy()
    if (row) {
      await prisma.auditEvent.update({ where: { id: row.id }, data: { metadata: '{"tampered":true}' } })
      const res = await verifyChain({ chainKey })
      expect(res.valid).toBe(false)
      expect(res.mismatches.length).toBeGreaterThan(0)
    }
  })
})
