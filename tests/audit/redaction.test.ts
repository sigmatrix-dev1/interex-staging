import { describe, it, expect } from 'vitest'
import { applyAuditRedaction } from '#app/utils/audit-redaction.server.ts'

function makeEvent(meta: any, diff: any) {
  return {
    id: 'e1',
    metadata: JSON.stringify(meta),
    diff: JSON.stringify(diff),
  } as any
}

describe('audit redaction', () => {
  it('passes through unchanged for system admin', () => {
    const ev = makeEvent({ patientName: 'Alice', requestId: 'r1' }, { changed: { patientName: 'Alice' } })
    const out = applyAuditRedaction(ev, { isSystemAdmin: true })
    expect(out.metadata).toContain('Alice')
    expect(out.redacted).toBe(false)
  })
  it('redacts sensitive metadata keys for non-admin', () => {
    const ev = makeEvent({ patientName: 'Alice', requestId: 'r1', unknown: 'x' }, { changed: { patientName: 'Alice', safe: 'ok' } })
    const out = applyAuditRedaction(ev, { isSystemAdmin: false })
  const meta: any = JSON.parse(out.metadata!)
  expect(meta.patientName).toBe('[REDACTED]')
  expect(meta.requestId).toBe('r1')
  expect(meta.unknown).toBeUndefined()
  const diff: any = JSON.parse(out.diff!)
  expect(diff.changed.patientName).toBe('[REDACTED]')
  expect(diff.changed.safe).toBe('ok')
    expect(out.redacted).toBe(true)
  })
})
