import { describe, it, expect } from 'vitest'
import { applyAuditRedaction } from '#app/utils/audit-redaction.server.ts'
import { PHI_SENSITIVE_KEYS, PHI_REDACTED_TOKEN } from '#app/utils/phi-constants.ts'

describe('PHI constants integration', () => {
  it('redacts any key added to PHI_SENSITIVE_KEYS automatically', () => {
    const dynamicKey = PHI_SENSITIVE_KEYS[0] // take first known key
    const ev: any = { metadata: JSON.stringify({ [dynamicKey]: 'VALUE', safe: 'ok' }), diff: JSON.stringify({ changed: { [dynamicKey]: 'VALUE' } }) }
    const out = applyAuditRedaction(ev, { isSystemAdmin: false })
    const meta: any = JSON.parse(out.metadata!)
    expect(meta[dynamicKey]).toBe(PHI_REDACTED_TOKEN)
  })
})
