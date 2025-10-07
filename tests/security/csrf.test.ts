import { describe, test, expect } from 'vitest'
import { action as forgotPasswordAction } from '#app/routes/_auth+/forgot-password.tsx'
import { action as resetPasswordAction } from '#app/routes/_auth+/reset-password.tsx'

// Directly invoke route actions so we exercise the same assertCsrf logic without requiring a running HTTP server/MSW handlers.

describe('CSRF protections', () => {
  test('missing csrf on forgot-password yields 403', async () => {
    const form = new FormData()
    form.set('usernameOrEmail', 'nonexistent@example.com')
    const req = new Request('http://localhost/_auth/forgot-password', { method: 'POST', body: form })
    let status = 0
    try {
      await forgotPasswordAction({ request: req } as any)
      status = 200 // would only happen if CSRF not enforced
    } catch (e: any) {
      if (e instanceof Response) status = e.status
      else status = 500
    }
    expect(status).toBe(403)
  })

  test('missing csrf on reset-password yields 403 (or redirect 302 if session precondition fails earlier)', async () => {
    const form = new FormData()
    form.set('password', 'SomePass!12345')
    form.set('confirmPassword', 'SomePass!12345')
    const req = new Request('http://localhost/_auth/reset-password', { method: 'POST', body: form })
    let status = 0
    try {
      await resetPasswordAction({ request: req } as any)
      status = 200
    } catch (e: any) {
      if (e instanceof Response) status = e.status
      else status = 500
    }
    expect([302, 403]).toContain(status)
  })
})
