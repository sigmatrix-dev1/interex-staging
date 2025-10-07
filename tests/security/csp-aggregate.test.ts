import { describe, it, expect } from 'vitest'
import { loader as aggLoader } from '#app/routes/admin.csp-violations.tsx'
import { action as cspReportAction, _setCspThrottleForTests } from '#app/routes/csp-report.ts'
import { sessionKey } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { authSessionStorage } from '#app/utils/session.server.ts'

async function makeAdmin() {
  await prisma.role.upsert({ where: { name: 'system-admin' }, update: {}, create: { name: 'system-admin', description: 'System admin' } })
  const u = await prisma.user.create({ data: { email: 'agg-admin@example.com', username: 'agg-admin', name: 'Agg Admin', roles: { connect: { name: 'system-admin' } }, password: { create: { hash: 'x' } }, twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP', passwordChangedAt: new Date() }, select: { id: true } })
  const session = await prisma.session.create({ data: { userId: u.id, expirationDate: new Date(Date.now()+3600_000) }, select: { id: true } })
  return session.id
}
async function buildAuthCookie(sessionId: string) {
  const s = await authSessionStorage.getSession()
  s.set(sessionKey, sessionId)
  return await authSessionStorage.commitSession(s)
}

function buildCspReq(blocked: string) {
  const payload = { 'csp-report': { 'document-uri': 'https://ex.test', 'violated-directive': 'script-src', 'effective-directive': 'script-src', 'blocked-uri': blocked } }
  return new Request('http://localhost/csp-report', { method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json', 'user-agent': 'agg-tester' } })
}

describe('CSP aggregate loader', () => {
  it('aggregates top directives for system-admin', async () => {
    _setCspThrottleForTests(5, 60_000)
    const sid = await makeAdmin()
    const cookie = await buildAuthCookie(sid)
    for (let i=0;i<3;i++) await cspReportAction({ request: buildCspReq(`https://evil.test/${i}`) })
    await cspReportAction({ request: buildCspReq('https://evil.test/repeat') })
    const res: any = await aggLoader({ request: new Request('http://localhost/admin/csp-violations', { headers: { cookie } }) } as any)
    const top = res?.data?.topDirectives
    expect(Array.isArray(top)).toBe(true)
    const entry = top.find((t: any)=>t.directive==='script-src')
    expect(entry?.count).toBeGreaterThanOrEqual(4)
  })

  it('forbids non-admin', async () => {
    // create basic user
  const u = await prisma.user.create({ data: { email: 'basic@example.com', username: 'basic-user-csp', name: 'Basic', roles: { connectOrCreate: { where: { name: 'user' }, create: { name: 'user', description: 'User' } } }, password: { create: { hash: 'x' } }, twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP', passwordChangedAt: new Date() }, select: { id: true } })
    const session = await prisma.session.create({ data: { userId: u.id, expirationDate: new Date(Date.now()+3600_000) }, select: { id: true } })
    const cookie = await buildAuthCookie(session.id)
    let status = 0
    try {
      await aggLoader({ request: new Request('http://localhost/admin/csp-violations', { headers: { cookie } }) } as any)
      status = 200
    } catch (e: any) {
      if (e instanceof Response) status = e.status
    }
    expect(status).toBe(403)
  })
})
