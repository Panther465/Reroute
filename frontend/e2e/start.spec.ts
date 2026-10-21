import { expect, test, type Page } from '@playwright/test'

// Starting a trip from scratch on one screen. Needs the full stack with DEMO_LOGIN=true and the AI
// helper on (Gemini or its pattern parser). Skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

/** Reset the demo through the API: the sample day comes back and trips started in the demo go. */
async function resetDemo(page: Page) {
  // Sign in afresh for the reset (with one retry), so it never depends on the page's own session.
  for (let attempt = 0; attempt < 3; attempt++) {
    const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
    const token = login.ok() ? ((await login.json()) as { accessToken?: string }).accessToken : undefined
    if (!token) continue
    const res = await page.request.post('/v1/trips/trip-001/demo/reset', { headers: { Authorization: `Bearer ${token}` }, data: { idempotencyKey: `e2e-reset-${Date.now()}-${attempt}` } })
    if (res.ok()) return
  }
  throw new Error("Couldn't reset the demo")
}

test.afterEach(async ({ page }) => resetDemo(page))

test('add to today from Today: one sentence, and the day updates where you are', async ({ page }) => {
  test.setTimeout(120_000)
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
  await resetDemo(page)
  await page.goto('/plan')
  await page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Add to today' }).click()
  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('What do you need to do?').fill('Coffee with a friend in Koramangala for 30 minutes')
  await sheet.getByRole('button', { name: 'Turn into tasks' }).click()
  await expect(sheet.getByRole('heading', { name: 'Check your tasks' })).toBeVisible({ timeout: 30_000 })
  const unplaced = sheet.getByLabel(/^Where is the /)
  if ((await unplaced.count()) > 0) {
    await unplaced.first().fill('Koramangala')
    await sheet.getByRole('list', { name: 'Places found' }).first().getByRole('button').first().click()
  }
  await sheet.getByRole('button', { name: /^Add \d+ tasks?$/ }).click()

  // No trip to the Plan tab: the plan updates and Today shows it.
  await expect(page.getByRole('region', { name: /Notifications/ }).getByRole('listitem').filter({ hasText: 'Your day is updated' })).toBeVisible({ timeout: 30_000 })
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('main').getByText(/coffee/i).first()).toBeVisible()
})

test('start a trip on one screen: describe the day, check the tasks, and it is planned', async ({ page }) => {
  test.setTimeout(150_000)
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
  await resetDemo(page)

  await page.goto('/plan')
  await page.getByRole('button', { name: 'Start a new trip' }).click()
  const main = page.getByRole('main')
  await main.getByLabel('Where are you staying?', { exact: true }).fill('Majestic')
  await main.getByRole('list', { name: 'Places found' }).getByRole('button', { name: /Hotel near Majestic/ }).first().click()
  // A fixed future day, so the plan never depends on the time the test runs.
  await main.getByRole('button', { name: 'Change dates' }).click()
  await main.getByLabel('First day').fill('2030-01-15')
  await main.getByLabel(/What do you need to do/).fill('Meeting at 10am at the ITPL Road office in Whitefield, then bank work in Koramangala')
  await main.getByRole('button', { name: 'Plan my day' }).click()

  // The description comes back as tasks to check; any task without a place gets one.
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('heading', { name: 'Check your tasks' })).toBeVisible({ timeout: 30_000 })
  const unplaced = sheet.getByLabel(/^Where is the /)
  for (let i = 0; i < 5 && (await unplaced.count()) > 0; i++) {
    await unplaced.first().fill('Koramangala')
    await sheet.getByRole('list', { name: 'Places found' }).first().getByRole('button').first().click()
  }
  await sheet.getByRole('button', { name: /^Plan (it|these \d+)$/ }).click()

  // Planned, and on Today: the new trip, not the sample one.
  await expect(page).toHaveURL(/\/$/, { timeout: 45_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Bengaluru' })).toBeVisible()
  await expect(page.getByText('Sample trip')).toHaveCount(0)
  await expect(page.getByRole('main').getByText(/^Leave for /).first()).toBeVisible()

  // Your trips: both trips are there, and the sample one comes back with a tap.
  await page.getByRole('button', { name: /Your trips/ }).click()
  const trips = page.getByRole('dialog')
  await expect(trips.getByRole('heading', { name: 'Your trips' })).toBeVisible()
  await expect(trips.getByRole('listitem')).toHaveCount(2)
  await trips.getByRole('button', { name: /Sample trip/ }).click()
  await expect(page.getByRole('main').getByText('Sample trip')).toBeVisible()
})

test('a detail screen opened cold still has a way back', async ({ page }) => {
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
  for (const [path, home] of [
    ['/leg/99', /\/$/],
    ['/raasta/route/no-such-route', /\/raasta$/],
  ] as const) {
    await page.goto(path)
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(home)
  }
})
