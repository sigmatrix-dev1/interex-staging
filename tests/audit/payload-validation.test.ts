import { describe, it, expect } from 'vitest'
import { validateAndSerializePayload, AUDIT_METADATA_MAX } from '#app/utils/audit-hash.ts'

describe('validateAndSerializePayload', () => {
  it('serializes metadata and diff', () => {
    const r = validateAndSerializePayload({ a: 1 }, { b: 2 })
    expect(r.metadataJson).toBeDefined()
    expect(r.diffJson).toBeDefined()
  })
  it('enforces metadata size', () => {
    const big = 'x'.repeat(AUDIT_METADATA_MAX + 10)
    expect(() => validateAndSerializePayload(big, undefined)).toThrow(/metadata exceeds/i)
  })
  it('detects PHI patterns (SSN)', () => {
    expect(() => validateAndSerializePayload({ note: 'Patient SSN 123-45-6789' }, undefined)).toThrow(/PHI/i)
  })
  it('allows PHI when allowed', () => {
    const r = validateAndSerializePayload({ note: 'SSN 123-45-6789' }, undefined, { allowPhi: true })
    expect(r.metadataJson).toBeTruthy()
    expect(r.phiDetected).toBe(true)
  })
})
