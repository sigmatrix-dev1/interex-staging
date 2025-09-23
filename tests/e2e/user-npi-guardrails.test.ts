// E2E Skeleton: User NPI Guard Rails
// Ensures users only see eligible NPIs based on group membership.
import { test, expect } from '@playwright/test'

test.describe('User NPI Guard Rails', () => {
  test('assign drawer shows only ungrouped NPIs for ungrouped user', async ({ page }) => {
    // TODO: Implement login + fixture seeding
    await page.goto('/customer/users')
    await expect(page.getByText('User Management')).toBeVisible()
  })

  test('assign drawer shows only group NPIs for grouped user', async ({ page }) => {
    await page.goto('/customer/users')
    await expect(page.getByText('User Management')).toBeVisible()
  })
})
