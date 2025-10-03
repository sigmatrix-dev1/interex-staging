import { expect, test } from '#tests/playwright-utils.ts'

/**
 * Auth rate limit smoke test (requires AUTH_RATE_LIMIT_ENABLED=true in env when running tests)
 * Strategy: trigger more than configured attempts to confirm we eventually get a 429 or block behavior.
 * To keep deterministic, we attempt a sequence of failed logins.
 */

test('repeated bad logins eventually trigger rate limiting (if enabled)', async ({ page }) => {
  // Intentionally use a non-existent user so all attempts fail fast.
  const username = 'nonexistent_user_rate_limit'
  const badPassword = 'wrongpass'

  let blocked = false
  for (let i = 0; i < 15; i++) {
    await page.goto('/login')
    await page.getByRole('textbox', { name: /username/i }).fill(username)
    await page.getByLabel(/^password$/i).fill(badPassword)
    await page.getByRole('button', { name: /log in/i }).click()
    // If limiter responds with a 429 rendering some generic text, capture via response status
    const resp = await page.waitForResponse(r => r.url().includes('/login') || r.status() >= 400, { timeout: 5000 }).catch(()=>null)
    if (resp && resp.status() === 429) { blocked = true; break }
  }

  // If flag disabled, we tolerate not being blocked; if enabled we expect block=true
  const enabled = process.env.AUTH_RATE_LIMIT_ENABLED !== 'false'
  if (enabled) {
    expect(blocked).toBeTruthy()
  }
})
