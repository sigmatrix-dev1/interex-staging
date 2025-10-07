import { describe, it, expect } from 'vitest'
import { applyBulkAuditRedaction } from '#app/utils/audit-redaction.server.ts'

const sample = [{
  id: '1', createdAt: new Date().toISOString(), category: 'AUTH', action: 'LOGIN', status: 'SUCCESS',
  actorDisplay: 'Alice', actorType: 'USER', metadata: JSON.stringify({ patientName: 'Bob', requestId: 'req1' }), diff: JSON.stringify({ changed: { patientName: 'Bob', other: 'ok' } }),
} as any]

describe('export redaction parity', () => {
  it('redacts for non-admin bulk export', () => {
    const out = applyBulkAuditRedaction(sample, { isSystemAdmin: false })
  const meta: any = JSON.parse(out[0].metadata)
  expect(meta.patientName).toBe('[REDACTED]')
  expect(meta.requestId).toBe('req1')
  const diff: any = JSON.parse(out[0].diff)
  expect(diff.changed.patientName).toBe('[REDACTED]')
  expect(diff.changed.other).toBe('ok')
  })
  it('passes through for system-admin bulk export', () => {
    const out = applyBulkAuditRedaction(sample, { isSystemAdmin: true })
  const meta: any = JSON.parse(out[0].metadata)
  expect(meta.patientName).toBe('Bob')
  })
})
