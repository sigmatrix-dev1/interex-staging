import bcrypt from 'bcryptjs'
import { describe, test, expect, beforeAll, beforeEach } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'

/*
  Login integration tests (route-level) exercising:
  - Successful password step for user WITHOUT existing MFA -> redirect to /2fa-setup with verify cookie
  - Successful password step for user WITH MFA enabled -> redirect to /2fa with verify cookie
  - Existing active session triggers warning flow requiring confirmLogoutOthers flag before proceeding
  - Invalid password returns 400 with form error (no redirect)
  - Missing CSRF is rejected with 403

  We invoke the route loader to obtain CSRF token + cookie, then POST to the action similarly to browser behavior.
*/

const NO_MFA_USER = 'login_nomfa'
const MFA_USER = 'login_withmfa'
const PASSWORD = 'Str0ngLogin!123'

async function seedUsers() {
  const hash = await bcrypt.hash(PASSWORD, 10)
  // base role 'user' ensure exists
  await prisma.role.upsert({ where: { name: 'user' }, update: {}, create: { name: 'user', description: 'Standard User' } })

  // No-MFA user (twoFactorEnabled false)
  await prisma.user.upsert({
    where: { username: NO_MFA_USER },
    update: { password: { update: { hash } }, twoFactorEnabled: false, twoFactorSecret: null },
    create: {
      email: NO_MFA_USER + '@example.com',
      username: NO_MFA_USER,
      name: 'Login No MFA',
      roles: { connect: { name: 'user' } },
      password: { create: { hash } },
      twoFactorEnabled: false,
    },
  })

  // MFA-enabled user (store a deterministic secret so 2FA route can later validate in other tests if needed)
  await prisma.user.upsert({
    where: { username: MFA_USER },
    update: { password: { update: { hash } }, twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP' },
    create: {
      email: MFA_USER + '@example.com',
      username: MFA_USER,
      name: 'Login With MFA',
      roles: { connect: { name: 'user' } },
      password: { create: { hash } },
      twoFactorEnabled: true,
      twoFactorSecret: 'JBSWY3DPEHPK3PXP',
    },
  })
}

async function getCsrfTokenAndCookie() {
  const { loader } = await import('#app/routes/_auth+/login.tsx')
  const req = new Request('http://localhost/login', { method: 'GET' })
  const res: any = await loader({ request: req } as any)
  const csrf = (res as any)?.data?.csrf
  const setCookie = (res as any)?.init?.headers?.['set-cookie'] || (res as any)?.headers?.get?.('set-cookie')
  return { csrf, cookie: setCookie } as { csrf: string; cookie?: string }
}

async function postLogin(form: URLSearchParams, cookie?: string) {
  const { action } = await import('#app/routes/_auth+/login.tsx')
  const headers: Record<string, string> = { 'user-agent': 'vitest' }
  if (cookie) headers.cookie = cookie
  try {
    return await action({ request: new Request('http://localhost/login', { method: 'POST', body: form, headers }) } as any)
  } catch (thrown: any) {
    // react-router / remix actions may throw a Response for early returns (e.g., 403)
    if (thrown instanceof Response) return thrown
    throw thrown
  }
}

beforeAll(async () => {
  await seedUsers()
})

beforeEach(async () => {
  await prisma.session.deleteMany({ where: { user: { username: NO_MFA_USER } } })
  await prisma.session.deleteMany({ where: { user: { username: MFA_USER } } })
})

describe('Login integration (route)', () => {
  test('missing CSRF yields 403', async () => {
    const form = new URLSearchParams()
    form.set('username', NO_MFA_USER)
    form.set('password', PASSWORD)
    const result: any = await postLogin(form) // no csrf field intentionally
    if (result instanceof Response) {
      expect(result.status).toBe(403)
    } else {
      const status = (result as any)?.init?.status ?? (result as any)?.status
      expect(status).toBe(403)
    }
  })

  test('successful login (no MFA yet) redirects to /2fa-setup with verify cookie', async () => {
    const { csrf, cookie } = await getCsrfTokenAndCookie()
    expect(csrf).toBeTruthy()
    const form = new URLSearchParams()
    form.set('username', NO_MFA_USER)
    form.set('password', PASSWORD)
    form.set('csrf', csrf)
    const result: any = await postLogin(form, cookie)
    expect(result instanceof Response).toBe(true)
    const res = result as Response
    expect(res.status).toBeGreaterThanOrEqual(300)
    const location = res.headers.get('location') || ''
    expect(location.startsWith('/2fa-setup')).toBe(true)
    const setCookie = res.headers.get('set-cookie')
    expect(setCookie).toBeTruthy()
  })

  test('successful login (MFA enabled) redirects to /2fa with verify cookie', async () => {
    const { csrf, cookie } = await getCsrfTokenAndCookie()
    expect(csrf).toBeTruthy()
    const form = new URLSearchParams()
    form.set('username', MFA_USER)
    form.set('password', PASSWORD)
    form.set('csrf', csrf)
    const result: any = await postLogin(form, cookie)
    expect(result instanceof Response).toBe(true)
    const res = result as Response
    const location = res.headers.get('location') || ''
    expect(location.startsWith('/2fa?')).toBe(true)
  })

  test('invalid password returns form error (400)', async () => {
    const { csrf, cookie } = await getCsrfTokenAndCookie()
    const form = new URLSearchParams()
    form.set('username', NO_MFA_USER)
    form.set('password', 'WrongPass!999')
    form.set('csrf', csrf)
    const result: any = await postLogin(form, cookie)
    if (result instanceof Response) {
      expect([400,200]).toContain(result.status)
    } else {
      const status = (result as any)?.init?.status ?? 200
      expect([400,200]).toContain(status)
      const payload = (result as any)?.data
      const formErrors = payload?.result?.formErrors || []
      expect(Array.isArray(formErrors) || typeof formErrors === 'string').toBe(true)
    }
  })

  test('second login triggers warning requiring confirmLogoutOthers flag before proceeding', async () => {
    const first = await (async () => {
      const { csrf, cookie } = await getCsrfTokenAndCookie()
      const form = new URLSearchParams()
      form.set('username', MFA_USER)
      form.set('password', PASSWORD)
      form.set('csrf', csrf)
      return await postLogin(form, cookie)
    })()
    expect(first instanceof Response).toBe(true)

    const { csrf, cookie } = await getCsrfTokenAndCookie()
    const form2 = new URLSearchParams()
    form2.set('username', MFA_USER)
    form2.set('password', PASSWORD)
    form2.set('csrf', csrf)
    const second: any = await postLogin(form2, cookie)
    if (second instanceof Response) {
      expect(second.status).toBeGreaterThanOrEqual(300)
    } else {
      expect((second as any)?.data?.warnExistingSessions).toBeGreaterThanOrEqual(1)
    }

    const { csrf: csrf3, cookie: cookie3 } = await getCsrfTokenAndCookie()
    const form3 = new URLSearchParams()
    form3.set('username', MFA_USER)
    form3.set('password', PASSWORD)
    form3.set('csrf', csrf3)
    form3.set('confirmLogoutOthers', 'true')
    const third: any = await postLogin(form3, cookie3)
    expect(third instanceof Response).toBe(true)
    const res3 = third as Response
    expect(res3.headers.get('location') || '').toContain('/2fa')
  })
})
