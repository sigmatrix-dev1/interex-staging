import { describe, it, expect } from 'vitest'
import { getPasswordHash } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'

// This test ensures that prior to completing MFA verification the primary auth cookie (en_session)
// is NOT issued, preventing session fixation / privilege before second factor.

async function createUserWith2FA(username: string) {
  const hash = await getPasswordHash('P@ssw0rd!')
  const user = await prisma.user.create({
    data: {
      email: `${username}@example.com`,
      username,
      name: 'Test User',
      password: { create: { hash } },
      twoFactorEnabled: true,
      twoFactorSecret: 'TESTSECRET', // token verification bypassed or mocked in test harness
      roles: { connectOrCreate: { where: { name: 'basic-user' }, create: { name: 'basic-user', description: 'Basic user' } } },
      passwordChangedAt: new Date(),
    },
    select: { id: true, username: true },
  })
  return user
}

// Utility to extract cookie names from Set-Cookie headers
function cookieNames(resHeaders: Headers) {
  const out = new Set<string>()
  for (const [k,v] of resHeaders.entries()) {
    if (k.toLowerCase() === 'set-cookie') {
      const parts = v.split(/, (?=[^;]+=)/) // naive split safe for our simple cookies
      for (const p of parts) {
        const seg = p.split('=')[0]
        if (seg) out.add(seg)
      }
    }
  }
  return Array.from(out)
}

describe('MFA pre-verification session fixation guard', () => {
  it('does not issue en_session before MFA verification for 2FA-enabled user', async () => {
  const { username } = await createUserWith2FA('fixationuser')

    // Simulate password-only login success path by calling the login.server.ts handleNewSession entry indirectly.
    // Instead, we mimic what the route does: create a session via login() then call handleNewSession without 2FA token.
    const { login } = await import('#app/utils/auth.server.ts')
    const { handleNewSession } = await import('#app/routes/_auth+/login.server.ts')

    // First: perform credential verification & create session object
    const fakeRequest = new Request('http://localhost/login', { method: 'POST', headers: { 'user-agent': 'test' } })
  const session = await login(fakeRequest, { username, password: 'P@ssw0rd!' })
  expect(session).toBeTruthy()
  if (!session) throw new Error('Expected session from login')

    // Now call handleNewSession WITHOUT twoFAVerified to trigger 2FA redirect
    let response: Response | null = null
    try {
      response = await handleNewSession({ request: fakeRequest, session, remember: false }, {})
    } catch (r) {
      if (r instanceof Response) response = r
      else throw r
    }
    expect(response).toBeTruthy()
    expect(response!.status).toBe(302)

    const names = cookieNames(response!.headers)
    // Should NOT have en_session yet.
    expect(names).not.toContain('en_session')
  })
})
