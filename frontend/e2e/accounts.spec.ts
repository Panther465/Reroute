import { expect, test, type Page } from '@playwright/test'

// A real account from the home screen, set up with Roo; and the wallet paying for a flight.
// Needs the full stack with DEMO_LOGIN=true. Skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

/** Answer Roo's question by tapping one of the answers it offers. */
async function answer(page: Page, label: string) {
  await page.getByRole('group', { name: 'Answers' }).getByRole('button', { name: label }).click()
}

/** Search for a place in the chat and pick the sample one by name (never a live map search result). */
async function place(page: Page, query: string, name: string) {
  await page.getByLabel('Search for a place').fill(query)
  await page.getByRole('group', { name: 'Places found' }).getByRole('button', { name: new RegExp(name) }).first().click()
}

test('create an account, meet Roo, and plan a day by chatting', async ({ page }) => {
  test.setTimeout(150_000)
  const roo = page.getByRole('log', { name: 'Conversation with Roo' })
  const said = (text: string | RegExp) => expect(roo.getByText(text).last()).toBeVisible({ timeout: 30_000 })

  await page.goto('/signin')
  await page.getByLabel('Your name').fill('Asha Rao')
  await page.getByLabel('Email').fill(`asha.${Date.now()}.${Math.round(Math.random() * 1e6)}@example.com`)
  await page.getByLabel('Password', { exact: true }).fill('rerouting-is-fun')
  await page.getByRole('button', { name: 'Create my account' }).click()

  await expect(page).toHaveURL(/\/welcome$/, { timeout: 20_000 })
  await said('Hi Asha! I’m Roo.')
  await said('Which city are you visiting?')
  await answer(page, 'Bengaluru')
  await said('When are you there?')
  await answer(page, 'From today')
  await said('And for how many days?')
  await answer(page, 'Just that day')
  await said(/Where are you staying\?/)
  await place(page, 'Majestic', 'Hotel near Majestic')
  await said(/first thing you need to do/)
  await page.getByLabel('Message Roo').fill('Bank')
  await page.getByRole('button', { name: 'Send' }).click()
  await said('Where is the bank?')
  await place(page, '80 Feet Road', 'Bank, 80 Feet Road')
  await said('Does it happen at a fixed time?')
  await answer(page, 'Any time')
  await said('How long will the bank take?')
  await answer(page, '30 min')
  await said('Added. Anything else today?')
  await answer(page, 'That’s all, plan my day')
  await said('Your day is planned!')
  await answer(page, 'Show my day')
  await expect(page.getByRole('heading', { level: 1, name: 'Bengaluru' })).toBeVisible({ timeout: 20_000 })

  // Later, Roo re-plans by asking what changed, and asks before starting over.
  await page.getByRole('button', { name: /Chat with Roo|Ask Roo/ }).first().click()
  const chat = page.getByRole('dialog', { name: 'Roo' })
  await chat.getByLabel('Message Roo').fill('hey i wanna re plan')
  await chat.getByRole('button', { name: 'Send' }).click()
  await expect(chat.getByText('What’s changed?').last()).toBeVisible({ timeout: 20_000 })
  await chat.getByRole('group', { name: 'Answers' }).getByRole('button', { name: 'Start a new trip' }).click()
  // Matched anywhere in the line: once typed out, it reads "Roo: Are you sure?…" (the name is for screen readers).
  await expect(chat.getByText('Are you sure?').last()).toBeVisible({ timeout: 20_000 })
  await chat.getByRole('group', { name: 'Answers' }).getByRole('button', { name: 'Never mind' }).click()
  await expect(chat.getByText('Okay, your plan stays as it is.').last()).toBeVisible({ timeout: 20_000 })
})

test('the wallet pays for a flight, and adding money fills a gap', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
  // A demo reset puts the wallet back to its demo balance, less than a business seat.
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  const reset = await page.request.post('/v1/trips/trip-001/demo/reset', { headers: { Authorization: `Bearer ${token}` }, data: { idempotencyKey: `e2e-reset-${Date.now()}` } })
  expect(reset.ok()).toBe(true)
  await page.goto('/me')
  await expect(page.getByRole('heading', { name: 'Wallet' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connected services' })).toBeVisible()

  await page.goto('/plan')
  await page.getByRole('button', { name: 'Book a flight' }).click()
  const sheet = page.getByRole('dialog', { name: /Book a flight/ })
  await sheet.getByRole('button', { name: 'Find flights' }).click()
  await sheet.locator('label').filter({ hasText: 'Business' }).first().click()
  await sheet.getByRole('button', { name: /^Continue with/ }).click()
  await sheet.getByLabel('Age').fill('34')
  await sheet.getByRole('button', { name: 'Review and pay' }).click()

  // A business seat costs more than the wallet holds: Pay waits until money is added.
  const pay = sheet.getByRole('button', { name: /^Pay ₹.* from your wallet$/ })
  await expect(pay).toBeDisabled()
  await sheet.getByRole('button', { name: 'Add money' }).click()
  const add = page.getByRole('dialog', { name: 'Add money' })
  await add.getByLabel('Or another amount, in rupees').fill('50000')
  await add.getByRole('button', { name: /^Add ₹/ }).click()
  await expect(add.getByText(/Your balance is/)).toBeVisible({ timeout: 15_000 })
  await expect(add).toBeHidden({ timeout: 10_000 })
  await expect(pay).toBeEnabled()
  await pay.click()
  const ticket = page.getByRole('dialog', { name: 'Your flight' })
  await expect(ticket.getByText(/^PNR [A-Z0-9]{6}$/)).toBeVisible({ timeout: 20_000 })
  await ticket.getByRole('button', { name: 'Cancel the flight' }).click()
  await expect(page.getByRole('region', { name: /Notifications/ }).getByRole('listitem').filter({ hasText: /back in your wallet/ })).toBeVisible({ timeout: 15_000 })
})

test.describe('the theme toggle', () => {
  test.use({ colorScheme: 'dark' })

  test('switches away from the system theme and keeps it after a reload', async ({ page }) => {
    await page.goto('/signin')
    const toggle = page.getByRole('button', { name: 'Dark mode' })
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('button', { name: 'Dark mode' })).toHaveAttribute('aria-pressed', 'false')
  })
})
