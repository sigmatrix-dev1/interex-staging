import { describe, it, expect } from 'vitest'
import { runSecurityEventDigestJob } from '#app/services/security-event-digest-job.server.ts'
import { prisma } from '#app/utils/db.server.ts'

// Helper to insert sample security events within a controlled window
async function seedSecurityEvents(from: Date, count: number) {
  for (let i = 0; i < count; i++) {
    await prisma.securityEvent.create({
      data: {
        kind: 'TEST_EVENT',
        success: i % 2 === 0,
        createdAt: new Date(from.getTime() + i * 1000),
        reason: i % 2 === 0 ? 'even' : 'odd',
      },
    })
  }
}

describe('security event digest job', () => {
  it('computes digest for empty window', async () => {
    const from = new Date('2025-01-01T00:00:00.000Z')
    const to = new Date('2025-01-01T01:00:00.000Z')
    const res = await runSecurityEventDigestJob({ from, to })
    expect(res.count).toBe(0)
    expect(res.hash).toMatch(/^[a-f0-9]{64}$/)
    const audit = await prisma.auditEvent.findFirst({ where: { chainKey: 'SECURITY_EVENT_DIGEST', summary: { contains: from.toISOString() } } })
    expect(audit?.summary).toContain('count=0')
  })

  it('computes digest with events and links chain sequentially', async () => {
    const from = new Date('2025-02-01T00:00:00.000Z')
    const to = new Date('2025-02-01T00:10:00.000Z')
    await seedSecurityEvents(from, 5)
    const res1 = await runSecurityEventDigestJob({ from, to })
    expect(res1.count).toBe(5)
  const tail1 = await prisma.auditEvent.findFirst({ where: { chainKey: 'SECURITY_EVENT_DIGEST', summary: { contains: from.toISOString() } } })
    expect(tail1?.metadata).toBeTruthy()
  const meta1: any = JSON.parse(tail1!.metadata!)
  expect(meta1.hash).toBe(res1.hash)

    // Re-run same window; should create a second entry (idempotence not enforced unless skipIfExists)
    const res2 = await runSecurityEventDigestJob({ from, to })
    expect(res2.created).toBe(true)
    const all = await prisma.auditEvent.findMany({ where: { chainKey: 'SECURITY_EVENT_DIGEST' }, orderBy: { seq: 'asc' } })
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all[1]!.hashPrev).toBe(all[0]!.hashSelf)
  })
})
