import { faker } from '@faker-js/faker'
import { generateTOTP } from '#app/utils/totp.server.ts'
import { expect, test } from '#tests/playwright-utils.ts'

test('Users can enable 2FA via /me/2fa and use it during login', async ({ page, login }) => {
  const password = faker.internet.password()
  const user = await login({ password })

  // Go straight to the unified 2FA setup page
  await page.goto('/me/2fa')

  // Start setup
  await page.getByRole('button', { name: /set up 2fa/i }).click()

  // Read the secret from the page and generate a valid OTP
  const secretLine = await page.getByText(/^Secret:/i).innerText()
  const secret = secretLine.replace(/^Secret:\s*/i, '')
  const otp = (await generateTOTP({ secret, algorithm: 'SHA-1' })).otp

  // Enter code and enable 2FA
  await page.getByRole('textbox', { name: /verification code/i }).fill(otp)
  await page.getByRole('button', { name: /verify & enable 2fa/i }).click()

  // Should land back on /me/2fa with success state
  await expect(page).toHaveURL('/me/2fa')
  await expect(page.getByText(/two-factor authentication is enabled/i)).toBeVisible()

  // Logout via user dropdown
  await page.getByRole('button', { name: user.name ?? user.username }).click()
  await page.waitForSelector('[data-slot="dropdown-menu-item"]', { timeout: 5000 })
  await page.getByRole('button', { name: /logout/i }).click()
  await expect(page).toHaveURL(`/`)

  // Login should now require 2FA
  await page.goto('/login')
  await page.getByRole('textbox', { name: /username/i }).fill(user.username)
  await page.getByLabel(/^password$/i).fill(password)
  await page.getByRole('button', { name: /log in/i }).click()

  // On /2fa, enter current code and sign in
  const loginOtp = (await generateTOTP({ secret, algorithm: 'SHA-1' })).otp
  await page.getByRole('textbox', { name: /verification code/i }).fill(loginOtp)
  await page.getByRole('button', { name: /verify & sign in/i }).click()

  // See user dropdown again => logged in
  await expect(page.getByRole('button', { name: user.name ?? user.username })).toBeVisible()
})
