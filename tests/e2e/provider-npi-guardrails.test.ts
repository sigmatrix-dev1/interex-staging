// E2E: Provider NPI Guard Rails
// Focus: user/group assignment constraints
// NOTE: This is a skeleton; flesh out with real auth helpers & data setup utilities.
import { test, expect } from '@playwright/test'

// Assumptions (adjust to project utilities):
// - There exist helper commands/fixtures to create customer, groups, users, and providers.
// - Login helper returns an authenticated page context.
// For now we pseudo-code interactions; implement with actual selectors present in UI.

test.describe('Provider NPI Guard Rails', () => {
  test('cannot assign grouped user to ungrouped provider', async ({ page }) => {
    // PREP: login as customer admin (pseudo)
    // await loginAs(page, 'customer-admin@example.com')

    // Navigate
    await page.goto('/customer/provider-npis')

    // Locate a provider row with no group and open Assign Users
    // (Selectors may need adjustment to real data-testids)
    // Example: find first row where Provider Group cell contains 'No group'

    // This is a placeholder expectation ensuring page loaded.
    await expect(page.getByText('Provider NPI Management')).toBeVisible()
  })

  test('blocks adding group when ungrouped users assigned', async ({ page }) => {
    await page.goto('/customer/provider-npis')
    await expect(page.getByText('Provider NPI Management')).toBeVisible()
  })

  test('only users in provider group are listed for grouped provider', async ({ page }) => {
    await page.goto('/customer/provider-npis')
    await expect(page.getByText('Provider NPI Management')).toBeVisible()
  })
})
