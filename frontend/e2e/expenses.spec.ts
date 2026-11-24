import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { ricoHere, ricoLocked } from './rico'

// The expense manager on the demo day: the plan's fares come in as estimates, a typed line becomes an
// expense with its receipt, the office's limit is flagged, and a claim gets its report and CSV.
// Needs the full stack with DEMO_LOGIN=true. Skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

// A 2×2 white PNG: small, and a real image the browser can open and shrink.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8//8/AxMDAwMTAwMDAwAkBgMBmjCi+wAAAABJRU5ErkJggg==', 'base64')

/** The demo day from its start, with no expenses left from another test (a reset clears them), then planned. */
async function demoDay(page: Page) {
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  const reset = await page.request.post('/v1/trips/trip-001/demo/reset', { headers: { Authorization: `Bearer ${token}` }, data: { idempotencyKey: `e2e-exp-${Date.now()}` } })
  expect(reset.ok()).toBe(true)
  // The reset's sign-in left its session cookie in this browser: the app may open signed in already.
  await page.goto('/signin')
  const demo = page.getByRole('button', { name: 'Use the demo account' })
  await expect(demo.or(page.getByRole('navigation', { name: 'Main' }))).toBeVisible()
  if (await demo.isVisible()) await demo.click()
  await expect(page).not.toHaveURL(/signin/)
  await page.goto('/plan')
  await page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
}

test.afterEach(async ({ page }) => {
  // Leave the demo day as the other tests expect it.
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  await page.request.post('/v1/trips/trip-001/demo/reset', { headers: { Authorization: `Bearer ${token}` }, data: { idempotencyKey: `e2e-exp-after-${Date.now()}` } })
})

test('track the demo day’s expenses, set a limit, and claim them back', async ({ page }) => {
  test.setTimeout(150_000)
  await demoDay(page)

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Expenses' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Expenses' })).toBeVisible()
  const main = page.getByRole('main')
  // The plan's fares are there by themselves, as estimates.
  await expect(main.getByText('From the plan').first()).toBeVisible({ timeout: 15_000 })

  // A typed line, checked and saved with a receipt.
  await main.getByLabel('Type an expense, like Lunch 350 cash').fill('Lunch 950 card at Truffles')
  await main.getByRole('button', { name: 'Add', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Add an expense' })
  await expect(sheet.getByLabel('Amount (₹)')).toHaveValue('950')
  await expect(sheet.getByLabel('Food')).toBeChecked()
  await expect(sheet.getByLabel('Card')).toBeChecked()
  await sheet.locator('input[type=file]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG })
  await expect(sheet.getByRole('img', { name: 'The receipt' })).toBeVisible()
  await sheet.getByRole('button', { name: 'Add the expense' }).click()
  const lunch = main.getByRole('button', { name: /Lunch at Truffles/ })
  await expect(lunch).toBeVisible()
  await expect(lunch).toContainText('Receipt')
  await expect(lunch).not.toContainText('Needs a receipt')

  // The office allows ₹800 a day for food.
  await main.getByRole('button', { name: 'Set a budget' }).first().click()
  const budget = page.getByRole('dialog', { name: 'Budget and limits' })
  await budget.getByLabel('Food a day (₹)').fill('800')
  await budget.getByRole('button', { name: 'Save the budget' }).click()
  await expect(main.getByText(/Food on .*: ₹950, ₹150 over the ₹800 a day allowed\./)).toBeVisible()
  await expect(lunch).toContainText('Over the limit by ₹150')

  // Claim it: the estimates wait to be confirmed.
  await main.getByRole('button', { name: /^Claim ₹950 back$/ }).click()
  const claim = page.getByRole('dialog', { name: 'Claim ₹950 back' })
  await expect(claim.getByText(/still the plan’s estimate/)).toBeVisible()
  await claim.getByRole('button', { name: 'Make the claim' }).click()
  await expect(main.getByText(/^RR-[0-9A-Z]{6}$/)).toBeVisible()
  await expect(lunch).toContainText('Claimed')

  // Its CSV for the office, and the printable report.
  const [download] = await Promise.all([page.waitForEvent('download'), main.getByRole('button', { name: 'CSV', exact: true }).click()])
  expect(download.suggestedFilename()).toMatch(/^reroute-expenses-RR-[0-9A-Z]{6}\.csv$/)
  const csv = await readFile((await download.path())!, 'utf-8')
  expect(csv).toContain('Lunch at Truffles')
  expect(csv).toContain('950.00')

  await main.getByRole('link', { name: 'Report', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Expense report' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Expenses' }).getByText('Lunch at Truffles')).toBeVisible()
  await expect(page.getByRole('img', { name: /Receipt: Lunch at Truffles/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible()
})

test('tell Rico what you spent, ask him how much, and it’s in your expenses', async ({ page }) => {
  test.skip(!ricoHere, ricoLocked)
  test.setTimeout(150_000)
  await demoDay(page)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Expenses' }).click()
  const main = page.getByRole('main')
  await expect(main.getByText('From the plan').first()).toBeVisible({ timeout: 15_000 })

  // "Ask Rico" opens his chat with the question, and he answers from the expenses.
  await main.getByRole('button', { name: 'Ask Rico about my spending' }).click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  const log = chat.getByRole('log', { name: 'Conversation with Rico' })
  await expect(log).toContainText(/You’ve spent ₹[\d,]+ so far\./, { timeout: 15_000 })

  // What he's told he puts on a card; nothing is added until it's tapped.
  await chat.getByLabel('Message Rico').fill('I paid 80 for an auto, cash')
  await chat.getByRole('button', { name: 'Send' }).click()
  await expect(log).toContainText('Got it, ₹80. Here’s how I’ll file it')
  // The card shows the expense itself before the tap.
  await expect(chat.getByRole('region', { name: 'Add to your expenses' })).toContainText('Travel · Cash')
  await chat.getByRole('button', { name: 'Add it' }).click()
  await expect(log).toContainText(/Added! ₹80 for Auto, under travel\./, { timeout: 15_000 })
  await expect(chat.getByRole('region', { name: 'Added to your expenses' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(main.getByRole('button', { name: /^Auto/ })).toBeVisible({ timeout: 15_000 })
})
