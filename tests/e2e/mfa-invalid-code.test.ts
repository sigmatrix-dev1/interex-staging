import { faker } from '@faker-js/faker'
import { generateTOTP } from '#app/utils/totp.server.ts'
import { expect, test } from '#tests/playwright-utils.ts'

// Negative path: invalid MFA code during login verification displays error and stays on page.

test('invalid MFA code shows error and does not advance', async ({ page, login }) => {
  const password = faker.internet.password()
  const user = await login({ password })

  // Enable MFA first
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

  // Attempt login (will require MFA)
  await page.goto('/login')
  await page.getByRole('textbox', { name: /username/i }).fill(user.username)
  await page.getByLabel(/^password$/i).fill(password)
  await page.getByRole('button', { name: /log in/i }).click()
  await expect(page).toHaveURL(/\/2fa(\?|$)/)

  // Enter bad code (alter a valid otp by incrementing a digit)
  const goodLoginOtp = (await generateTOTP({ secret, algorithm: 'SHA-1' })).otp
  const badOtp = goodLoginOtp.replace(/.$/, d => ((parseInt(d,10)+1) % 10).toString())
  await page.getByRole('textbox', { name: /verification code/i }).fill(badOtp)
  await page.getByRole('button', { name: /verify & sign in/i }).click()

  // Should still be on /2fa with an error message
  await expect(page).toHaveURL(/\/2fa(\?|$)/)
  await expect(page.getByText(/invalid verification code/i)).toBeVisible()

  // Now enter valid code and succeed
  const validOtp = (await generateTOTP({ secret, algorithm: 'SHA-1' })).otp
  await page.getByRole('textbox', { name: /verification code/i }).fill(validOtp)
  await page.getByRole('button', { name: /verify & sign in/i }).click()
  await expect(page.getByRole('button', { name: user.name ?? user.username })).toBeVisible()
})
