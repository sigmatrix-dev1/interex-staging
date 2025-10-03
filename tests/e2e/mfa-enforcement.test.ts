import { faker } from '@faker-js/faker'
import { generateTOTP } from '#app/utils/totp.server.ts'
import { expect, test } from '#tests/playwright-utils.ts'

/**
 * MFA Enforcement Scenarios
 * - Non system-admin without MFA: blocked and redirected to /2fa-setup after login
 * - System-admin without MFA: allowed through (banner warning visible later in UI - not asserted here if separate layout)
 * - Non system-admin with MFA: normal 2-step login works
 */

test.describe('MFA enforcement', () => {
  test('non system-admin without MFA is forced into setup flow', async ({ page, login }) => {
    const password = faker.internet.password()
  const user = await login({ password })

    // Log out to start fresh
    await page.goto('/logout').catch(()=>{})

    // Attempt login (no MFA yet)
    await page.goto('/login')
    await page.getByRole('textbox', { name: /username/i }).fill(user.username)
    await page.getByLabel(/^password$/i).fill(password)
    await page.getByRole('button', { name: /log in/i }).click()

    // Should be redirected to setup (not generic /2fa)
    await expect(page).toHaveURL(/\/2fa-setup/) // regex to allow query params
    await expect(page.getByRole('heading', { name: /set up two-factor authentication/i })).toBeVisible()
  })

  test('non system-admin with MFA completes login via verify page', async ({ page, login }) => {
    const password = faker.internet.password()
  const user = await login({ password })

    // Enable MFA first via /me/2fa flow
    await page.goto('/me/2fa')
    await page.getByRole('button', { name: /set up 2fa/i }).click()
    const secretLine = await page.getByText(/^Secret:/i).innerText()
    const secret = secretLine.replace(/^Secret:\s*/i, '')
    const otp = (await generateTOTP({ secret, algorithm: 'SHA-1' })).otp
    await page.getByRole('textbox', { name: /verification code/i }).fill(otp)
    await page.getByRole('button', { name: /verify & enable 2fa/i }).click()
    await expect(page.getByText(/two-factor authentication is enabled/i)).toBeVisible()

    // Logout
    await page.goto('/logout').catch(()=>{})

    // Login again, expect /2fa verify (not setup)
    await page.goto('/login')
    await page.getByRole('textbox', { name: /username/i }).fill(user.username)
    await page.getByLabel(/^password$/i).fill(password)
    await page.getByRole('button', { name: /log in/i }).click()

    await expect(page).toHaveURL(/\/2fa(\?|$)/)
    const loginOtp = (await generateTOTP({ secret, algorithm: 'SHA-1' })).otp
    await page.getByRole('textbox', { name: /verification code/i }).fill(loginOtp)
    await page.getByRole('button', { name: /verify & sign in/i }).click()

    // Logged in (presence of some user UI element)
    await expect(page.getByRole('button', { name: user.name ?? user.username })).toBeVisible()
  })
})
