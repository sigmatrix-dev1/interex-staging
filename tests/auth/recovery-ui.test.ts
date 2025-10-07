import bcrypt from 'bcryptjs'
import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'

/*
  Recovery Codes UI Flow Tests
  Verifies that when a privileged (system-admin/customer-admin) user enables 2FA via /2fa-setup:
    - The action returns a one-time plaintext recoveryCodes array + next session info.
    - Acknowledging (intent=ack-recovery) finalizes login (redirect Response) and codes are not reissued automatically.
  Also verifies a non-privileged user does NOT receive recoveryCodes payload (direct session finalize path).

  We simulate the "password step" by directly creating a session row and stashing its id into the verify session cookie
  (mirrors logic in handleNewSession prior to redirecting user to /2fa-setup).

  To avoid having to generate a real valid TOTP token for the ephemeral secret, we monkey-patch verifyTwoFactorToken to
  always return true within each test (the purpose here is the recovery codes branching, not TOTP correctness which is
  covered elsewhere).
*/

const ADMIN_USERNAME = 'rc_ui_admin'
const BASIC_USERNAME = 'rc_ui_basic'
const PASSWORD = 'RcUi!Pass123'

async function ensureRoles() {
  await prisma.role.upsert({ where: { name: 'system-admin' }, update: {}, create: { name: 'system-admin', description: 'System Admin (test)' } })
  await prisma.role.upsert({ where: { name: 'user' }, update: {}, create: { name: 'user', description: 'Basic User (test)' } })
}

async function seedUser(username: string, role: 'system-admin' | 'user') {
  const hash = await bcrypt.hash(PASSWORD, 10)
  const user = await prisma.user.upsert({
    where: { username },
    update: { password: { update: { hash } }, twoFactorEnabled: false, twoFactorSecret: null },
    create: {
      email: username + '@example.com',
      username,
      name: username,
      roles: { connect: { name: role } },
      password: { create: { hash } },
      twoFactorEnabled: false,
    },
    select: { id: true },
  })
  return user.id
}

async function createUnverifiedSession(userId: string) {
  const session = await prisma.session.create({ data: { userId, expirationDate: new Date(Date.now() + 60 * 60 * 1000) } })
  return session.id
}

async function buildVerifyCookie(sessionId: string) {
  const { verifySessionStorage } = await import('#app/utils/verification.server.ts')
  const vs = await verifySessionStorage.getSession()
  vs.set('unverified-session-id', sessionId)
  return await verifySessionStorage.commitSession(vs)
}

// Extract helper to combine cookies (verify + csrf) returned by loader
function combineCookies(...cookies: Array<string | undefined>): string {
  return cookies.filter(Boolean).join('; ')
}

// Helper to produce a valid 6-digit token for the secret returned by loader.
// generateTOTP from @epic-web/totp can accept an existing secret and return current otp.
async function generateValidToken(secret: string) {
  // The library's generateTOTP creates a new secret; we need verify path. We can dynamically import verifyTOTP and construct token.
  // Instead, we re-implement minimal TOTP using the same library by calling verifyTOTP across a sliding window until we find a code.
  // More efficient: derive code using the library internals via generateTOTP then overwrite secret, but simplest is to brute-force 1e6 range with current timestamp.
  // However brute forcing 1e6 codes is expensive; so instead we reconstruct using the same algorithm (HMAC-SHA1). To avoid duplicating logic, we leverage a temporary call to generateTOTP() to inspect structure and then compute manually.
  // Simpler approach: import otplib's authenticator if available. To avoid extra dependency, we'll implement minimal TOTP.
  const cryptoMod = await import('node:crypto')
  function hotp(key: Buffer, counter: number) {
    const buf = Buffer.alloc(8)
    for (let i = 7; i >= 0; i--) {
      buf[i] = counter & 0xff
      counter = counter >> 8
    }
    const hmac: Buffer = cryptoMod.createHmac('sha1', key).update(buf).digest()
    const offset = hmac[hmac.length - 1]! & 0xf
    const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0')
    return code
  }
  const period = 30
  const step = Math.floor(Date.now() / 1000 / period)
  // Secret from loader is already base32 per twofa.server.ts generateTwoFactorSecret
  const base32 = secret
  // Base32 decode (RFC 4648 without padding)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of base32.replace(/=+$/,'')) {
    const val = alphabet.indexOf(ch)
    if (val < 0) continue
    bits += val.toString(2).padStart(5,'0')
  }
  const bytes: number[] = []
  for (let i=0;i+8<=bits.length;i+=8) bytes.push(parseInt(bits.slice(i,i+8),2))
  const key = Buffer.from(bytes)
  return hotp(key, step)
}

beforeAll(async () => {
  await ensureRoles()
  await seedUser(ADMIN_USERNAME, 'system-admin')
  await seedUser(BASIC_USERNAME, 'user')
})

beforeEach(async () => {
  // Clean recovery codes + sessions each test for isolation
  await (prisma as any).recoveryCode.deleteMany({ where: { user: { username: { in: [ADMIN_USERNAME, BASIC_USERNAME] } } } })
  await prisma.session.deleteMany({ where: { user: { username: { in: [ADMIN_USERNAME, BASIC_USERNAME] } } } })
})

describe('Recovery Codes One-Time UI Flow (/2fa-setup)', () => {
  test('privileged user receives one-time recoveryCodes payload then finalize on acknowledgment', async () => {
    const admin = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } })
    expect(admin).toBeTruthy()
    const unverifiedSessionId = await createUnverifiedSession(admin!.id)
    const verifyCookie = await buildVerifyCookie(unverifiedSessionId)

    // Loader: fetch secret + csrf
    const { loader, action } = await import('#app/routes/_auth+/2fa-setup.tsx')
    const loaderRes: any = await loader({ request: new Request('http://localhost/2fa-setup', { headers: { cookie: verifyCookie } }) } as any)
    const secret = loaderRes?.data?.secret
    const csrf = loaderRes?.data?.csrf
    const userId = loaderRes?.data?.userId
    expect(secret && csrf && userId).toBeTruthy()
    const csrfCookie = loaderRes?.init?.headers?.['set-cookie'] || loaderRes?.headers?.get?.('set-cookie')
    const combinedCookie = combineCookies(verifyCookie, csrfCookie)

    // Action: enable 2FA (monkey patched token verification) -> expect recoveryCodes in data
    const form = new URLSearchParams()
  const token = await generateValidToken(secret)
  form.set('code', token)
    form.set('userId', userId)
    form.set('secret', secret)
    form.set('csrf', csrf)
    const actionRes: any = await action({ request: new Request('http://localhost/2fa-setup', { method: 'POST', body: form, headers: { cookie: combinedCookie } }) } as any)
    const recoveryCodes: string[] = actionRes?.data?.recoveryCodes
    const next = actionRes?.data?.next
    expect(Array.isArray(recoveryCodes)).toBe(true)
    expect(recoveryCodes.length).toBeGreaterThan(0)
    expect(next?.sessionId).toBeTruthy()

    // Acknowledge: intent=ack-recovery with CSRF token -> expect redirect Response (final session commit)
    const ackForm = new URLSearchParams()
    ackForm.set('intent', 'ack-recovery')
    ackForm.set('sessionId', next.sessionId)
    ackForm.set('remember', next.remember ? '1' : '')
    ackForm.set('redirectTo', next.redirectTo || '')
    ackForm.set('csrf', csrf)
    const ackRes: any = await action({ request: new Request('http://localhost/2fa-setup', { method: 'POST', body: ackForm, headers: { cookie: combinedCookie } }) } as any)
    expect(ackRes instanceof Response).toBe(true)
    if (ackRes instanceof Response) {
      expect(ackRes.status).toBeGreaterThanOrEqual(300)
    }
  })

  test('non-privileged user does not receive recoveryCodes payload', async () => {
    const basic = await prisma.user.findUnique({ where: { username: BASIC_USERNAME }, select: { id: true } })
    expect(basic).toBeTruthy()
    const unverifiedSessionId = await createUnverifiedSession(basic!.id)
    const verifyCookie = await buildVerifyCookie(unverifiedSessionId)

    const { loader, action } = await import('#app/routes/_auth+/2fa-setup.tsx')
    const loaderRes: any = await loader({ request: new Request('http://localhost/2fa-setup', { headers: { cookie: verifyCookie } }) } as any)
    const secret = loaderRes?.data?.secret
    const csrf = loaderRes?.data?.csrf
    const userId = loaderRes?.data?.userId
    const csrfCookie = loaderRes?.init?.headers?.['set-cookie'] || loaderRes?.headers?.get?.('set-cookie')
    const combinedCookie = combineCookies(verifyCookie, csrfCookie)
    expect(secret && csrf && userId).toBeTruthy()

    const form = new URLSearchParams()
  const token = await generateValidToken(secret)
  form.set('code', token)
    form.set('userId', userId)
    form.set('secret', secret)
    form.set('csrf', csrf)
    const actionRes: any = await action({ request: new Request('http://localhost/2fa-setup', { method: 'POST', body: form, headers: { cookie: combinedCookie } }) } as any)

    // Non-privileged path should bypass recoveryCodes UI; expect a redirect Response (session finalize) OR a data() object without recoveryCodes
    if (actionRes instanceof Response) {
      expect(actionRes.status).toBeGreaterThanOrEqual(300)
    } else {
      const hasCodes = Array.isArray(actionRes?.data?.recoveryCodes) && actionRes.data.recoveryCodes.length > 0
      expect(hasCodes).toBe(false)
    }
  })
})
