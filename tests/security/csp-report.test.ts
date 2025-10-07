import { describe, it, expect } from 'vitest'
import { action as cspReportAction } from '#app/routes/csp-report.ts'
import { prisma } from '#app/utils/db.server.ts'

describe('CSP report endpoint', () => {
	it('stores a security event for valid report', async () => {
		const before = await prisma.securityEvent.count({ where: { kind: 'CSP_VIOLATION' } })
		const payload = {
			'csp-report': {
				'document-uri': 'https://example.test/page',
				'referrer': '',
				'violated-directive': 'script-src-elem',
				'effective-directive': 'script-src-elem',
				'blocked-uri': 'https://evil.test/x.js',
				'original-policy': "default-src 'self'" ,
			},
		}
		const req = new Request('http://localhost/csp-report', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } })
		const res = await cspReportAction({ request: req })
		expect(res.status).toBe(204)
		const after = await prisma.securityEvent.count({ where: { kind: 'CSP_VIOLATION' } })
		expect(after).toBe(before + 1)
	})

	it('ignores malformed payload gracefully', async () => {
		const before = await prisma.securityEvent.count({ where: { kind: 'CSP_VIOLATION' } })
		const req = new Request('http://localhost/csp-report', { method: 'POST', body: 'not-json', headers: { 'content-type': 'application/json' } })
		const res = await cspReportAction({ request: req })
		expect(res.status).toBe(204)
		const after = await prisma.securityEvent.count({ where: { kind: 'CSP_VIOLATION' } })
		expect(after).toBe(before) // no change
	})
})
