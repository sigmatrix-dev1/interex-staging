import { describe, it, expect } from 'vitest'
import { getOrCreateCsrfToken, assertCsrf } from '#app/utils/csrf.server.ts'

// Minimal simulation: create a session cookie with CSRF token then validate assertCsrf passes.

describe('CSRF positive flow', () => {
  it('accepts matching token', async () => {
  const req1 = new Request('http://localhost/any', { headers: { cookie: '' } })
    const { token, setCookie } = await getOrCreateCsrfToken(req1)
    expect(token).toBeDefined()

    const form = new FormData()
    form.set('csrf', token)
    const req2 = new Request('http://localhost/mutate', { method: 'POST', headers: { cookie: setCookie || '' } })
    await expect(assertCsrf(req2, form)).resolves.toBeUndefined()
  })
})
