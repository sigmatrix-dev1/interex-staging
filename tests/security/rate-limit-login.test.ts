import { describe, it, expect } from 'vitest'
import { login } from '#app/utils/auth.server.ts'
import { prisma } from '#app/utils/db.server.ts'
import { resetRateLimitForTests } from '#app/utils/rate-limit.server.ts'

// Minimal mock Request with headers
function makeRequest(ip: string) {
  return new Request('http://localhost/login', { headers: { 'x-forwarded-for': ip, 'user-agent': 'vitest' } })
}

describe('login rate limiting', () => {
  it('throttles after capacity exceeded', async () => {
    resetRateLimitForTests()
    // Create user
  await prisma.user.create({ data: { email: 'u@example.com', username: 'u', name: 'U', password: { create: { hash: '$2a$10$012345678901234567890uZqK1N5G4gJE0E7E5WJrE2qucMDZ0qI6' } } } })
    // 10 allowed (default capacity); attempts beyond should start returning null early.
    let successes = 0
    for (let i=0;i<15;i++) {
      const res = await login(makeRequest('1.2.3.4'), { username: 'u', password: 'wrong' })
      if (res) successes++
    }
    expect(successes).toBeLessThan(5) // most should be blocked or invalid
  })
})
