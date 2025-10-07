import { describe, it, expect } from 'vitest'
import { verifyChain } from '#app/services/audit-verify.server.ts'
import { audit } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

async function seedChain(chainKey: string, count: number) {
  for (let i=0;i<count;i++) {
    await audit.security({
      action: 'TEST_EVENT',
      status: 'SUCCESS',
      actorType: 'SYSTEM',
      actorId: 'seed',
      chainKey,
      entityType: 'Test',
      entityId: String(i),
      summary: 'Seed event '+i,
      metadata: { i },
    })
  }
}

// We cannot UPDATE existing rows (append-only triggers). To simulate tampering,
// append a forged row whose hashSelf does NOT match the canonical recomputation.
async function appendForgedTampered(chainKey: string) {
  const tail = await prisma.auditEvent.findFirst({ where: { chainKey }, orderBy: { seq: 'desc' } })
  if (!tail) throw new Error('No tail row to forge after')
  await prisma.auditEvent.create({
    data: {
      chainKey,
      seq: tail.seq + 1,
      hashPrev: tail.hashSelf, // linkage is correct
      // Deliberately incorrect hashSelf (random) so verification recompute fails
      hashSelf: 'forged_'+Math.random().toString(16).slice(2),
      actorType: 'SYSTEM',
      category: 'SYSTEM',
      action: 'FORGED_EVENT',
      status: 'SUCCESS',
      summary: 'Forged tampered event'
    }
  })
}

describe('Audit chain verification', () => {
  it('detects intact chain as valid', async () => {
    const key = 'test-chain-intact'
    await seedChain(key, 5)
    const result = await verifyChain({ chainKey: key })
    expect(result.valid).toBe(true)
  expect(result.mismatches).toHaveLength(0)
  })

  it('detects tampering (hashSelf mismatch) via forged append', async () => {
    const key = 'test-chain-corrupt'
    await seedChain(key, 4)
    await appendForgedTampered(key)
    const result = await verifyChain({ chainKey: key, includePayload: true })
    expect(result.valid).toBe(false)
    expect(result.mismatches.length).toBeGreaterThan(0)
    const mismatch = result.mismatches[0]!
    expect(mismatch.reason).toBe('hashSelf mismatch')
  })
})
