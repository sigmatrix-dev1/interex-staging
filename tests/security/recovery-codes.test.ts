import bcrypt from 'bcryptjs'
import { describe, it, beforeAll, expect } from 'vitest'
import { prisma } from '#app/utils/db.server.ts'
import { issueRecoveryCodes, consumeRecoveryCode, remainingRecoveryCodes } from '#app/utils/mfa.server.ts'
import { createUser } from '#tests/db-utils'

async function createBasicUser(username: string, role: string) {
  const userData = createUser()
  return prisma.user.create({
    data: {
      ...userData,
      username,
      roles: { connect: { name: role } },
      password: { create: { hash: await bcrypt.hash('pw', 10) } },
    },
    select: { id: true },
  })
}

describe('Recovery codes', () => {
  let adminId: string
  let basicId: string

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { username: { in: ['rc-admin', 'rc-basic'] } } })
    // Ensure roles exist
    await prisma.role.upsert({ where: { name: 'system-admin' }, update: {}, create: { name: 'system-admin', description: 'System admin (test)' } })
    await prisma.role.upsert({ where: { name: 'basic-user' }, update: {}, create: { name: 'basic-user', description: 'Basic user (test)' } })
    adminId = (await createBasicUser('rc-admin', 'system-admin')).id
    basicId = (await createBasicUser('rc-basic', 'basic-user')).id
  })

  it('issues codes only for privileged roles', async () => {
    const adminCodes = await issueRecoveryCodes(adminId, { actorType: 'USER', actorId: adminId })
    expect(adminCodes.length).toBeGreaterThan(0)
    const basicCodes = await issueRecoveryCodes(basicId, { actorType: 'USER', actorId: basicId })
  expect(basicCodes).toHaveLength(0)
  })

  it('consumes a code exactly once', async () => {
    const codes = await issueRecoveryCodes(adminId, { actorType: 'USER', actorId: adminId }, { auditAction: 'MFA_RECOVERY_REGENERATE' })
  const first = codes[0] || ''
  const good = await consumeRecoveryCode(adminId, first, {})
    expect(good.ok).toBe(true)
  const reuse = await consumeRecoveryCode(adminId, first, {})
    expect(reuse.ok).toBe(false)
    const remaining = await remainingRecoveryCodes(adminId)
    expect(remaining).toBe(codes.length - 1)
  })
})
