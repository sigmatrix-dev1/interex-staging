import { describe, it, expect, beforeAll } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'
import { createPassword } from '#app/utils/password'
import { createUser } from '#tests/db-utils'

// Configure lockout env BEFORE importing login util
process.env.LOCKOUT_ENABLED = 'true'
process.env.LOCKOUT_THRESHOLD = '3'
process.env.LOCKOUT_BASE_COOLDOWN_SEC = '300'
let login: any

// These tests assume LOCKOUT_ENABLED=true with low threshold for speed (override via env when running this file)

async function attempt(username: string, password: string) {
  const req = new Request('http://localhost/login', { method: 'POST' })
  return login(req, { username, password })
}

describe('Account Lockout', () => {
  const username = 'lockout_user'
  const correctPw = 'correctpw'
  const threshold = Number(process.env.LOCKOUT_THRESHOLD || 3)

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { username } })
  const userData = createUser()
    // Ensure required role exists
    await prisma.role.upsert({ where: { name: 'user' }, update: {}, create: { name: 'user', description: 'Default user role (test)' } })
    await prisma.user.create({
      data: {
        ...userData,
        username,
        password: { create: createPassword(correctPw) },
        roles: { connect: { name: 'user' } },
      },
    })
    if (!login) {
      ;({ login } = await import('#app/utils/auth.server.ts'))
    }
  })

  it('locks after threshold failures and then clears after success', async () => {
    // Fail threshold times
    for (let i = 0; i < threshold; i++) {
      const res = await attempt(username, 'wrong')
      expect(res).toBeNull()
    }
    // One more attempt with correct password should still fail (locked)
    const lockedTry = await attempt(username, correctPw)
    expect(lockedTry).toBeNull()

    // Manually clear lock for test determinism
  // Use unchecked update via cast to allow additive fields not reflected in older generated client types.
  await (prisma as any).user.update({ where: { username }, data: { failedLoginCount: 0, lockedUntil: null } })

    const success = await attempt(username, correctPw)
    expect(success).not.toBeNull()
  })
})
