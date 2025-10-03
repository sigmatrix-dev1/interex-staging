import { test, expect } from '#tests/playwright-utils.ts'

// System-admin without MFA should be allowed to log in but (post-login UI) would show a warning.
// We assert successful direct access to an admin page without being forced into MFA setup.
// (Banner assertion can be added when route/layout guarantee is stable in tests.)

test('system-admin without MFA not blocked by hard non-admin enforcement', async ({ page, login }) => {
  const user = await login({ password: 'AdminTemp123!', role: 'system-admin' })

  // Start a fresh login flow to ensure enforcement path runs (logout first)
  await page.goto('/logout').catch(()=>{})
  await page.goto('/login')
  await page.getByRole('textbox', { name: /username/i }).fill(user.username)
  await page.getByLabel(/^password$/i).fill('AdminTemp123!')
  await page.getByRole('button', { name: /log in/i }).click()

  // Should NOT be redirected to /2fa-setup, should land on some dashboard/admin area.
  await expect(page).not.toHaveURL(/\/2fa-setup/)
  // Basic smoke: user navigation (dropdown button) appears meaning session committed
  await expect(page.getByRole('button', { name: user.name ?? user.username })).toBeVisible()
})
