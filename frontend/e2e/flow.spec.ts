import { expect, test, type Page } from '@playwright/test'

// The signature flow on the sample day, end to end. Needs the full stack with DEMO_LOGIN=true.
// Skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

const TRIP = 'trip-001'

async function openSimulate(page: Page) {
  await page.getByRole('button', { name: 'Simulate' }).click()
  await expect(page.getByRole('heading', { name: 'Simulate' })).toBeVisible()
}

test('running late, reroute, then undo', async ({ page }) => {
  test.setTimeout(120_000)

  // Demo sign-in.
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)

  // Reset the demo, so the run starts from the sample day with no plan.
  await openSimulate(page)
  const reset = page.waitForResponse((r) => r.url().endsWith(`/v1/trips/${TRIP}/demo/reset`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Reset the demo' }).click()
  expect((await reset).ok()).toBe(true)
  await expect(page).toHaveURL(/\/plan$/)

  // Plan my day.
  await page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Bengaluru' })).toBeVisible()

  // Set the trip clock to 10:55.
  await openSimulate(page)
  // A time input has no ARIA role of its own, so it is found by its label.
  const time = page.getByLabel('Current time')
  // The panel only sends a new time; the reset may already have left the clock at 10:55.
  if ((await time.inputValue()) !== '10:55') {
    const clock = page.waitForResponse((r) => r.url().endsWith(`/v1/trips/${TRIP}/demo/clock`) && r.request().method() === 'POST')
    await time.fill('10:55')
    // Leave the field to send it (Tab only moves between the hour and minute parts on desktop Chrome).
    await page.getByRole('heading', { name: 'Simulate' }).click()
    expect((await clock).ok()).toBe(true)
  }
  await page.keyboard.press('Escape')

  // Running late, about 40 min.
  await page.getByRole('button', { name: 'Running late' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toBeVisible()
  // The chip's radio is visually hidden inside its label: choose it from the keyboard.
  const forty = sheet.getByRole('radio', { name: 'About 40 min' })
  await forty.focus()
  await page.keyboard.press('Space')
  await expect(forty).toBeChecked()
  await sheet.getByRole('button', { name: 'Update my times' }).click()

  // The options show, and stay (refetches of the trip must not reset the sheet).
  await expect(sheet.getByRole('heading', { name: 'Choose how to fix your day' })).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(3000)
  await expect(sheet.getByRole('heading', { name: 'Choose how to fix your day' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Reroute my day' })).toBeVisible()

  // Reroute my day.
  await sheet.getByRole('button', { name: 'Reroute my day' }).click()
  await expect(sheet).toBeHidden({ timeout: 20_000 })
  // Toasts are list items in the Notifications region (Radix announces their text separately).
  const toasts = page.getByRole('region', { name: /Notifications/ })
  const toast = toasts.getByRole('listitem').filter({ hasText: 'Day rerouted' })
  await expect(toast).toBeVisible({ timeout: 10_000 })

  // Undo brings plan version 1 back. The app may update its cache from the activate response
  // rather than refetching, so check the server's answer directly.
  const activate = page.waitForRequest((r) => /\/plans\/\d+\/activate$/.test(r.url()) && r.method() === 'POST')
  await toast.getByRole('button', { name: 'Undo' }).click()
  expect((await activate).url()).toMatch(/\/plans\/1\/activate$/)
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  await expect
    .poll(async () => {
      const res = await page.request.get(`/v1/trips/${TRIP}`, { headers: { Authorization: `Bearer ${token}` } })
      return ((await res.json()) as { activePlan: { version: number } | null }).activePlan?.version
    }, { timeout: 15_000 })
    .toBe(1)
  await expect(toasts.getByRole('listitem').filter({ hasText: 'Your earlier plan is back' })).toBeVisible({ timeout: 10_000 })
})
