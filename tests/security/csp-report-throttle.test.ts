import { describe, it, expect } from 'vitest'
import { action as cspReportAction, _setCspThrottleForTests } from '#app/routes/csp-report.ts'
import { prisma } from '#app/utils/db.server.ts'

function buildReq(doc: string, ua = 'vitest-agent', ip?: string) {
  const payload = { 'csp-report': { 'document-uri': doc, 'violated-directive': 'script-src', 'effective-directive': 'script-src', 'blocked-uri': 'https://evil.test/x.js' } }
  const headers: Record<string,string> = { 'content-type': 'application/json', 'user-agent': ua }
  if (ip) headers['x-forwarded-for'] = ip
  return new Request('http://localhost/csp-report', { method: 'POST', body: JSON.stringify(payload), headers })
}

describe('CSP report throttling', () => {
  it('throttles after limit and emits CSP_VIOLATION_THROTTLED once', async () => {
    _setCspThrottleForTests(3, 60_000) // small limit for test
    const baseCount = await prisma.securityEvent.count({ where: { kind: { in: ['CSP_VIOLATION','CSP_VIOLATION_THROTTLED'] } } })

    // 4 reports -> 3 normal + 1 throttled marker
    for (let i=0;i<4;i++) {
      const res = await cspReportAction({ request: buildReq('https://example.test/page') })
      expect(res.status).toBe(204)
    }

    const violations = await prisma.securityEvent.count({ where: { kind: 'CSP_VIOLATION' } })
    const throttled = await prisma.securityEvent.count({ where: { kind: 'CSP_VIOLATION_THROTTLED' } })
    expect(violations).toBeGreaterThanOrEqual(3)
    expect(throttled).toBe(1)

    // Additional reports suppressed (no extra throttled events)
    for (let i=0;i<5;i++) await cspReportAction({ request: buildReq('https://example.test/page') })
    const throttledAfter = await prisma.securityEvent.count({ where: { kind: 'CSP_VIOLATION_THROTTLED' } })
    expect(throttledAfter).toBe(throttled)

    // Ensure no unrelated explosion of rows
    const totalDelta = await prisma.securityEvent.count({ where: { kind: { in: ['CSP_VIOLATION','CSP_VIOLATION_THROTTLED'] } } }) - baseCount
    expect(totalDelta).toBeLessThanOrEqual(10)
  })
})
