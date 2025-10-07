import crypto from 'node:crypto'
import { authSessionStorage } from '#app/utils/session.server.ts'

const CSRF_TOKEN_KEY = 'csrf-token'

export async function getOrCreateCsrfToken(request: Request) {
  const session = await authSessionStorage.getSession(request.headers.get('cookie'))
  let token = session.get(CSRF_TOKEN_KEY) as string | undefined
  let setCookie: string | undefined
  if (!token) {
    token = crypto.randomBytes(32).toString('base64url')
    session.set(CSRF_TOKEN_KEY, token)
    setCookie = await authSessionStorage.commitSession(session)
  }
  return { token, setCookie }
}

export async function assertCsrf(request: Request, formData: FormData) {
  const session = await authSessionStorage.getSession(request.headers.get('cookie'))
  const expected = session.get(CSRF_TOKEN_KEY) as string | undefined
  const provided = (formData.get('csrf') || formData.get('_csrf')) as string | null
  // In test env we default to 'enforce' so missing tokens yield deterministic 403s (no console.warn -> avoided test 500s)
  const defaultMode = process.env.NODE_ENV === 'test' ? 'enforce' : 'log'
  const mode = process.env.CSRF_MODE || defaultMode // 'off' | 'log' | 'enforce'
  const ok = !!expected && !!provided && expected === provided
  if (ok || mode === 'off') return
  if (!ok) {
    if (mode === 'log') {
      // Dev/phase metric only—avoid noisy details; tests will not hit this branch due to defaultMode override.
      console.warn('[csrf] mismatch', { expected: !!expected, provided: !!provided, path: new URL(request.url).pathname })
      return
    }
    // Enforce mode
    throw new Response('Invalid CSRF token', { status: 403 })
  }
}
