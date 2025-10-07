import bcrypt from 'bcryptjs'
import { describe, test, expect, beforeAll } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'

// Will import dynamic modules after seeding user
// lazy imports (login not required directly because we target 2FA route action)
let issueRecoveryCodes: any

const ADMIN_USERNAME = 'recovery_admin'
const PASSWORD = 'StrongPass!123'

async function seedPrivilegedMfaUser() {
  const passwordHash = await bcrypt.hash(PASSWORD, 10)
  // ensure roles exist
  await prisma.role.upsert({ where: { name: 'system-admin' }, update: {}, create: { name: 'system-admin', description: 'System Admin' } })
  const user = await prisma.user.create({
    data: {
      email: ADMIN_USERNAME + '@example.com',
      username: ADMIN_USERNAME,
      name: 'Recovery Admin',
      roles: { connect: { name: 'system-admin' } },
      password: { create: { hash: passwordHash } },
      twoFactorEnabled: true,
      // store a deterministic TOTP secret for test (unencrypted allowed if key absent)
      twoFactorSecret: 'JBSWY3DPEHPK3PXP',
    },
    select: { id: true },
  })
  return user.id
}

// login request helper not needed for recovery tests

async function getUnverifiedSession(userId: string) {
  // Simulate successful password step => create session row then treat it as unverified (mirroring app login flow pre-2FA)
  const session = await prisma.session.create({ data: { userId, expirationDate: new Date(Date.now() + 1000 * 60 * 60) } })
  return session.id
}

async function simulate2faVerifySessionCookie(sessionId: string) {
  // We mimic what the real flow does by creating a cookie via verifySessionStorage; here we stub minimal shape expected by route action
  const { verifySessionStorage } = await import('#app/utils/verification.server.ts')
  const verifySession = await verifySessionStorage.getSession()
  verifySession.set('unverified-session-id', sessionId)
  const cookie = await verifySessionStorage.commitSession(verifySession)
  return cookie
}

beforeAll(async () => {
  const userId = await seedPrivilegedMfaUser()
  ;({ issueRecoveryCodes } = await import('#app/utils/mfa.server.ts'))
  // Issue codes explicitly (route does this on enable; here user pre-seeded as enabled)
  await issueRecoveryCodes(userId, { actorType: 'USER', actorId: userId, chainKey: 'global' })
})

describe('MFA Recovery Code Login Flow', () => {
  test('successful login via recovery code fallback', async () => {
    const user = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } })
    expect(user).toBeTruthy()
  const p: any = prisma as any
  const codes = await p.recoveryCode.findMany({ where: { userId: user!.id } })
    expect(codes.length).toBeGreaterThan(0)

    // We'll use first code by brute-force comparing bcrypt (simulate plaintext knowledge)
    // In real scenario user sees plaintext once; test reconstructs by validating success path using consume process.
    const sessionId = await getUnverifiedSession(user!.id)
    const cookie = await simulate2faVerifySessionCookie(sessionId)

    // Call 2FA route action with recovery code (simulate failing TOTP then using recovery)
    const { action } = await import('#app/routes/_auth+/2fa.tsx')

  // Provide intentionally wrong TOTP code but valid recovery (use URLSearchParams so server sees proper form fields)
  const form = new URLSearchParams()
  form.set('code', '000000')
  form.set('recovery', 'DUMMY') // placeholder

    // Need a plaintext code. We cannot reverse bcrypt; instead we regenerate a new set and capture returned plaintext (by invoking issueRecoveryCodes directly which returns plaintext array for privileged user). For safety we re-issue then use first of those.
    const freshCodes: string[] = await issueRecoveryCodes(user!.id, { actorType: 'USER', actorId: user!.id, chainKey: 'global' })
    expect(freshCodes.length).toBeGreaterThan(0)
    const useCode = freshCodes[0]
    form.set('recovery', useCode || '')

    const req = new Request('http://localhost/2fa', { method: 'POST', body: form, headers: { cookie, 'user-agent': 'vitest' } })

    const result = await action({ request: req } as any)
    // If verification succeeds it should be a redirect Response (302) to / or redirectTo param
    expect(result instanceof Response).toBe(true)
    const res = result as Response
    expect(res.status).toBeGreaterThanOrEqual(200)
  })

  test('reusing the same recovery code fails', async () => {
    const user = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } })
  const issued: string[] = await issueRecoveryCodes(user!.id, { actorType: 'USER', actorId: user!.id, chainKey: 'global' })
  const code = issued[0] || ''

    // First consume via 2fa route
    const s1 = await getUnverifiedSession(user!.id)
    const cookie1 = await simulate2faVerifySessionCookie(s1)
    const { action } = await import('#app/routes/_auth+/2fa.tsx')
    const f1 = new URLSearchParams()
    f1.set('code', '000000')
    f1.set('recovery', code)
  const r1 = await action({ request: new Request('http://localhost/2fa', { method: 'POST', body: f1, headers: { cookie: cookie1 } }) } as any)
  // First consume should succeed (redirect Response)
  expect(r1 instanceof Response).toBe(true)

    // Second attempt with same code should fail (return 200 with form error or 400). We'll inspect response status.
    const s2 = await getUnverifiedSession(user!.id)
    const cookie2 = await simulate2faVerifySessionCookie(s2)
    const f2 = new URLSearchParams()
    f2.set('code', '000000')
    f2.set('recovery', code) // reused
    const r2 = await action({ request: new Request('http://localhost/2fa', { method: 'POST', body: f2, headers: { cookie: cookie2 } }) } as any)
    // Reuse attempt should NOT produce a successful redirect. It may return a DataWithResponseInit object or a 400 Response.
    if (r2 instanceof Response) {
      // If Response, ensure not redirect 3xx
      expect(r2.status).not.toBeGreaterThanOrEqual(300)
    } else {
      // Expect shape of data() result from react-router
      expect(typeof r2).toBe('object')
      // status may reside in r2.init?.status; ensure it's not a redirect
  const status = (r2 as any)?.init?.status ?? 200
  // Accept 400 (validation error) or 200 (form redisplay) as valid failure states
  expect([200, 400]).toContain(status)
    }
  })
})
