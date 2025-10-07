import { describe, it, expect, beforeAll } from 'vitest'
import { getPasswordHash } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { validatePasswordComplexity } from '#app/utils/password-policy.server.ts'

// Minimal integration-style test of mustChangePassword lifecycle

const ENABLE_POLICY_TESTS = process.env.PASSWORD_POLICY_EXPERIMENTAL === 'true'

const suite = ENABLE_POLICY_TESTS ? describe : describe.skip

suite('password lifecycle + policy', () => {
  const tempPassword = 'TempPassw0rd!'
  let userId: string

  beforeAll(async () => {
    if (!ENABLE_POLICY_TESTS) return
    const hash = await getPasswordHash(tempPassword)
    // Ensure role exists (create if missing) to avoid foreign key errors
    await prisma.role.upsert({
      where: { name: 'basic-user' },
      update: {},
      create: { name: 'basic-user', description: 'Basic user role (test)' },
    })
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
    if (!ENABLE_POLICY_TESTS) return
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
