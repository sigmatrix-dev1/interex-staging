import { describe, it, expect, beforeAll } from 'vitest'
import { getPasswordHash } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { validatePasswordComplexity } from '#app/utils/password-policy.server.ts'

// Minimal integration-style test of mustChangePassword lifecycle

describe('password lifecycle + policy', () => {
  const tempPassword = 'TempPassw0rd!'
  let userId: string

  beforeAll(async () => {
    // create a user with mustChangePassword true
    const hash = await getPasswordHash(tempPassword)
  // Cast prisma to any here temporarily because vitest's ts context has not
  // picked up regenerated prisma client types for mustChangePassword/passwordChangedAt
  const user = await (prisma as any).user.create({
      data: {
        email: 'policytest@example.com',
        username: 'policytest',
        name: 'Policy Test',
        mustChangePassword: true,
        password: { create: { hash } },
        roles: { connect: { name: 'basic-user' } },
      },
      select: { id: true },
    })
    userId = user.id
  })

  it('enforces complexity (happy path)', () => {
    const { ok, errors } = validatePasswordComplexity('Strong3rPass!!')
    expect(ok).toBe(true)
    expect(errors).toHaveLength(0)
  })

  it('flags weak password issues', () => {
    const { ok, errors } = validatePasswordComplexity('shortA1!')
    expect(ok).toBe(false)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('can clear mustChangePassword and set passwordChangedAt', async () => {
    const newHash = await getPasswordHash('NewStronger1!')
  await prisma.password.update({
      where: { userId },
      data: { hash: newHash },
    })
  await (prisma as any).user.update({
      where: { id: userId },
      data: { mustChangePassword: false, passwordChangedAt: new Date() },
    })
  const updated = await (prisma as any).user.findUnique({
      where: { id: userId },
      select: { mustChangePassword: true, passwordChangedAt: true }
    })
    expect(updated.mustChangePassword).toBe(false)
    expect(updated.passwordChangedAt).not.toBeNull()
  })
})
