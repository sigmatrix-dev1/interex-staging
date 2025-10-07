import bcrypt from 'bcryptjs'
import { describe, test, expect, beforeAll } from 'vitest'
import { sessionKey } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'

const USERNAME = 'regular_user_no_recovery'
const PASSWORD = 'StrongPass!123'
let userId: string

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(PASSWORD, 10)
  const user = await prisma.user.create({
    data: {
      email: USERNAME + '@example.com',
      username: USERNAME,
      name: 'Regular User',
      password: { create: { hash: passwordHash } },
      twoFactorEnabled: true,
      twoFactorSecret: 'JBSWY3DPEHPK3PXP',
      passwordChangedAt: new Date(), // ensure not expired for test
    },
    select: { id: true },
  })
  userId = user.id
})

describe('Recovery Codes - Non Privileged User', () => {
  test('issueRecoveryCodes returns empty array for non-privileged user', async () => {
    const { issueRecoveryCodes } = await import('#app/utils/mfa.server.ts')
    const codes: string[] = await issueRecoveryCodes(userId, { actorType: 'USER', actorId: userId, chainKey: 'global' })
  expect(codes).toHaveLength(0)
    const count = await (prisma as any).recoveryCode.count({ where: { userId } })
    expect(count).toBe(0)
  })

  test('attempt to access recovery management route returns 403', async () => {
    const { loader, action } = await import('#app/routes/me.2fa.recovery.tsx')

    // Build a session for the user to authenticate the request (simulate requireUserId)
    const session = await prisma.session.create({ data: { userId, expirationDate: new Date(Date.now() + 3600_000) } })
    const { authSessionStorage } = await import('#app/utils/session.server.ts')
    const authSession = await authSessionStorage.getSession()
  authSession.set(sessionKey, session.id)
    const cookie = await authSessionStorage.commitSession(authSession)

    const req = new Request('http://localhost/me/2fa/recovery', { headers: { cookie } })
    let status = 0
    try {
      await loader({ request: req } as any)
      status = 200
    } catch (e: any) {
      if (e instanceof Response) status = e.status
      else status = 500
    }
    expect(status).toBe(403)

    // Action attempt
    const form = new URLSearchParams()
    form.set('intent', 'generate')
    const postReq = new Request('http://localhost/me/2fa/recovery', { method: 'POST', body: form, headers: { cookie } })
    let actionStatus = 0
    try {
      const res = await action({ request: postReq } as any)
      actionStatus = res instanceof Response ? res.status : (res?.init?.status ?? 200)
    } catch (e: any) {
      if (e instanceof Response) actionStatus = e.status
      else actionStatus = 500
    }
    expect(actionStatus).toBe(403)
  })
})
