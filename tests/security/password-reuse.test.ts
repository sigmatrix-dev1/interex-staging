import { describe, it, expect } from 'vitest'
import { resetUserPassword, signup } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'

async function createUser(username: string) {
  await signup({ email: `${username}@example.com`, username, password: 'InitialPwd!1', name: 'Reuse' })
  return prisma.user.findUnique({ where: { username }, select: { id: true } })
}

describe('password reuse prevention', () => {
  it('blocks reusing current password', async () => {
    const uname = 'reuseA'
    await createUser(uname)
    const blocked = await resetUserPassword({ username: uname, password: 'InitialPwd!1' })
    expect(blocked).toBeNull()
  })
  it('allows changing to a new password then blocks reverting', async () => {
    const uname = 'reuseB'
    await createUser(uname)
    const ok = await resetUserPassword({ username: uname, password: 'SecondPwd!2' })
    expect(ok).not.toBeNull()
    const blocked = await resetUserPassword({ username: uname, password: 'InitialPwd!1' })
    expect(blocked).toBeNull()
  })
})
