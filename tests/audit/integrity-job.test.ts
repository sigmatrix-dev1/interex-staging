import { describe, it, expect } from 'vitest'
import { runAuditIntegrityJob } from '#app/services/audit-integrity-job.server.ts'
import { audit } from '#app/services/audit.server.ts'
import { prisma } from '#app/utils/db.server.ts'

async function seed(chainKey: string, n: number) {
  for (let i=0;i<n;i++) {
    await audit.system({
      action: 'TEST_EVENT',
      actorType: 'SYSTEM',
      actorId: 'sys',
      chainKey,
      status: 'SUCCESS',
      entityType: 'X',
      entityId: String(i),
      summary: 'Seed '+i,
      metadata: { i },
    })
  }
}

describe('audit integrity job', () => {
  it('logs OK event when no mismatches', async () => {
    await seed('job-ok', 3)
    const result = await runAuditIntegrityJob({ sampleLimitPerChain: 50 })
    expect(result.mismatchedChains).toBe(0)
    const evt = await prisma.securityEvent.findFirst({ where: { kind: 'AUDIT_CHAIN_INTEGRITY_OK' }, orderBy: { createdAt: 'desc' } })
    expect(evt).not.toBeNull()
  })
})
