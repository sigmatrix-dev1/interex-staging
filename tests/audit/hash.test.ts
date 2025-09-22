import { describe, it, expect } from 'vitest'
import { canonicalJson, computeAuditHashSelf } from '#app/utils/audit-hash.ts'

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    const a = canonicalJson({ b: 2, a: 1, c: { z: 9, y: 8 } })
    const b = canonicalJson({ c: { y: 8, z: 9 }, a: 1, b: 2 })
    expect(a).toEqual(b)
  })
  it('preserves array order', () => {
    const a = canonicalJson({ arr: [ { b:2, a:1 }, { c:3 } ] })
    const b = canonicalJson({ arr: [ { a:1, b:2 }, { c:3 } ] })
    expect(a).toEqual(b)
  })
})

describe('computeAuditHashSelf', () => {
  it('changes with sequence number', () => {
    const base = {
      chainKey: 'cust1',
      seq: 1,
      category: 'AUTH',
      action: 'LOGIN',
      status: 'SUCCESS',
      actorType: 'USER',
      actorId: 'u1',
      entityType: null,
      entityId: null,
      summary: null,
      metadata: { x: 1 },
      diff: null,
      hashPrev: null,
    }
    const h1 = computeAuditHashSelf(base)
    const h2 = computeAuditHashSelf({ ...base, seq: 2 })
    expect(h1).not.toEqual(h2)
  })
  it('incorporates hashPrev linkage', () => {
    const base = {
      chainKey: 'cust1',
      seq: 1,
      category: 'AUTH',
      action: 'LOGIN',
      status: 'SUCCESS',
      actorType: 'USER',
      actorId: 'u1',
      entityType: null,
      entityId: null,
      summary: null,
      metadata: { x: 1 },
      diff: null,
      hashPrev: null,
    }
    const h1 = computeAuditHashSelf(base)
    const h2 = computeAuditHashSelf({ ...base, seq: 2, hashPrev: h1 })
    expect(h1).not.toEqual(h2)
  })
})
