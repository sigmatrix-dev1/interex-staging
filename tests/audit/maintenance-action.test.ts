import { describe, it, expect } from 'vitest'
import { archiveOldAuditEvents } from '#app/services/audit-archive.server.ts'
import { verifyChain } from '#app/services/audit-verify.server.ts'
import { logAuditEvent } from '#app/services/audit.server.ts'

// Minimal test to exercise archive + verify interactions (not full route action test)

describe('Audit maintenance primitives', () => {
  it('archives a dry-run without modifying data', async () => {
    const chainKey = `maint-${Date.now()}`
    for (let i = 0; i < 3; i++) {
      await logAuditEvent({
        category: 'SYSTEM',
        action: 'MAINT_SEED',
        actorType: 'SYSTEM',
        chainKey,
        customerId: 'maintCust',
        summary: 'seed',
        metadata: { i },
      })
    }
    const dry = await archiveOldAuditEvents({ beforeDate: new Date(Date.now() + 1000), chainKey, dryRun: true })
    expect(dry.scanned).toBeGreaterThan(0)
    expect(dry.moved).toBe(0)
    const verify = await verifyChain({ chainKey })
    expect(verify.valid).toBe(true)
  })
})
