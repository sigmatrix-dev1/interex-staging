import { describe, it, expect } from 'vitest'
import { runAuditIntegrityJob } from '#app/services/audit-integrity-job.server.ts'
import { audit } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

async function seed(chainKey: string, n: number) {
  for (let i = 0; i < n; i++) {
    await audit.system({
      action: 'TEST_EVENT',
      actorType: 'SYSTEM',
      actorId: 'sys',
      chainKey,
      status: 'SUCCESS',
      entityType: 'Y',
      entityId: String(i),
      summary: 'Seed ' + i,
      metadata: { i },
    })
  }
}

async function forgeBad(chainKey: string) {
  const tail = await prisma.auditEvent.findFirst({ where: { chainKey }, orderBy: { seq: 'desc' } })
  if (!tail) throw new Error('No tail row')
  await prisma.auditEvent.create({
    data: {
      chainKey,
      seq: tail.seq + 1,
      hashPrev: tail.hashSelf,
      hashSelf: 'bad_'+Math.random().toString(16).slice(2),
      actorType: 'SYSTEM',
      category: 'SYSTEM',
      action: 'FORGED_EVENT',
      status: 'SUCCESS',
      summary: 'Forged bad event',
    },
  })
}

describe('audit integrity job failure path', () => {
  it('logs failure event when mismatch detected', async () => {
    const key = 'job-mismatch'
    await seed(key, 3)
    await forgeBad(key)
    const result = await runAuditIntegrityJob({ sampleLimitPerChain: 50 })
    expect(result.mismatchedChains).toBeGreaterThan(0)
    const failure = await prisma.securityEvent.findFirst({ where: { kind: 'AUDIT_CHAIN_INTEGRITY_FAILURE' }, orderBy: { createdAt: 'desc' } })
    expect(failure).not.toBeNull()
    const ok = await prisma.securityEvent.findFirst({ where: { kind: 'AUDIT_CHAIN_INTEGRITY_OK' } })
    expect(ok).toBeNull()
  })
})
