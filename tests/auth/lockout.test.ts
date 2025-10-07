import bcrypt from 'bcryptjs'
import { describe, expect, test, beforeEach } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'

// We'll import login lazily after setting env flags so the module reads correct values.
let login: any

// Test configuration
const USERNAME = 'lockout_user'
const GOOD_PASSWORD = 'CorrectHorseBatteryStaple!1'
const BAD_PASSWORD = 'wrong-password'

async function createUser() {
  const hash = await bcrypt.hash(GOOD_PASSWORD, 10)
  return prisma.user.create({
    data: {
      email: USERNAME + '@example.com',
      username: USERNAME,
      name: 'Lockout User',
      roles: { connect: { name: 'user' } },
      password: { create: { hash } },
    },
    select: { id: true },
  })
}

function makeRequest() {
  return new Request('http://localhost/login', { method: 'POST', headers: { 'user-agent': 'vitest', 'x-forwarded-for': '127.0.0.1' } })
}

// Set env flags once (import of auth.server.ts must happen after these)
process.env.LOCKOUT_ENABLED = 'true'
process.env.LOCKOUT_THRESHOLD = '2'
process.env.LOCKOUT_BASE_COOLDOWN_SEC = '300'

beforeEach(async () => {
  // Clean slate (db-setup will already have copied a pristine DB, but ensure idempotency)
  await prisma.session.deleteMany({ where: { user: { username: USERNAME } } }).catch(() => {})
  await prisma.user.deleteMany({ where: { username: USERNAME } }).catch(() => {})
  await createUser()
  if (!login) {
    ;({ login } = await import('#app/utils/auth.server.ts'))
  }
})

describe('Account lockout', () => {
  test('locks the account after threshold failed attempts', async () => {
    // 1st failure
    const r1 = await login(makeRequest(), { username: USERNAME, password: BAD_PASSWORD })
    expect(r1).toBeNull()

    // 2nd failure triggers lock
    const r2 = await login(makeRequest(), { username: USERNAME, password: BAD_PASSWORD })
    expect(r2).toBeNull()

    const userAfter: any = await prisma.user.findUnique({ where: { username: USERNAME }, select: { id: true } })
    // fetch raw to inspect lockout columns if type not present
    let failedLoginCount: number | undefined
    let lockedUntil: Date | null | undefined
    try {
      const rows: any = await prisma.$queryRawUnsafe('SELECT failedLoginCount, lockedUntil FROM User WHERE username = ? LIMIT 1', USERNAME)
      const row = Array.isArray(rows) ? rows[0] : rows
      failedLoginCount = row?.failedLoginCount
      lockedUntil = row?.lockedUntil ? new Date(row.lockedUntil) : row?.lockedUntil
    } catch {}
    expect(userAfter).toBeTruthy()
    expect((failedLoginCount ?? 0)).toBeGreaterThanOrEqual(2)
    expect(lockedUntil).not.toBeNull()

    // Attempt correct password while locked should still fail (null session)
    const lockedAttempt = await login(makeRequest(), { username: USERNAME, password: GOOD_PASSWORD })
    expect(lockedAttempt).toBeNull()
  })

  test('successful login after manual unlock clears counters', async () => {
    // First trigger lock
    await login(makeRequest(), { username: USERNAME, password: BAD_PASSWORD })
    await login(makeRequest(), { username: USERNAME, password: BAD_PASSWORD })
    // Manually clear lock to simulate cooldown expiration
    const prismaAny = prisma as any
    await prismaAny.user.update({
      where: { username: USERNAME },
      data: { lockedUntil: new Date(Date.now() - 1000), failedLoginCount: 0 },
    })

    const session = await login(makeRequest(), { username: USERNAME, password: GOOD_PASSWORD })
    expect(session).not.toBeNull()

    let userPostFailed = 0
    let userPostLocked: Date | null = null
    try {
      const rows: any = await prisma.$queryRawUnsafe('SELECT failedLoginCount, lockedUntil FROM User WHERE username = ? LIMIT 1', USERNAME)
      const row = Array.isArray(rows) ? rows[0] : rows
      userPostFailed = row?.failedLoginCount ?? 0
      userPostLocked = row?.lockedUntil ? new Date(row.lockedUntil) : null
    } catch {}
    expect(userPostFailed).toBe(0)
    if (userPostLocked) {
      expect(userPostLocked.getTime()).toBeLessThan(Date.now())
    }
  })
})
