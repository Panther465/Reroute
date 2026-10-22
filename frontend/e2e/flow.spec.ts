import { expect, test, type Page } from '@playwright/test'

// The signature flow on the sample day, end to end. Needs the full stack with DEMO_LOGIN=true.
// Skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

const TRIP = 'trip-001'

async function openSimulate(page: Page) {
  const heading = page.getByRole('heading', { name: 'Simulate' })
  if (!(await heading.isVisible())) await page.getByRole('button', { name: 'Simulate', exact: true }).click()
  await expect(heading).toBeVisible()
}

/** Demo sign-in, reset the sample day and plan it, ending on Today. */
async function planFreshDay(page: Page) {
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)

  await openSimulate(page)
  const reset = page.waitForResponse((r) => r.url().endsWith(`/v1/trips/${TRIP}/demo/reset`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Reset the demo' }).click()
  expect((await reset).ok()).toBe(true)
  await expect(page).toHaveURL(/\/plan$/)

  await page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Bengaluru' })).toBeVisible()
}

async function setClock(page: Page, hhmm: string) {
  await openSimulate(page)
  // A time input has no ARIA role of its own, so it is found by its label.
  const time = page.getByLabel('Current time')
  // The panel only sends a new time; the clock may already show it.
  if ((await time.inputValue()) !== hhmm) {
    const clock = page.waitForResponse((r) => r.url().endsWith(`/v1/trips/${TRIP}/demo/clock`) && r.request().method() === 'POST')
    await time.fill(hhmm)
    // Leave the field to send it (Tab only moves between the hour and minute parts on desktop Chrome).
    await page.getByRole('heading', { name: 'Simulate' }).click()
    expect((await clock).ok()).toBe(true)
  }
  await page.keyboard.press('Escape')
}

test('the day keeps up: leave, mark done, and add a task without planning again', async ({ page }) => {
  test.setTimeout(120_000)
  await planFreshDay(page)
  await setClock(page, '08:00')

  // Still at the hotel: the one main button says "I've left", not "Mark done".
  const actions = page.getByRole('main')
  await actions.getByRole('button', { name: "I've left" }).first().click()
  await expect(actions.getByRole('button', { name: /^Mark done/ }).first()).toBeVisible()
  // It remembers across a reload.
  await page.reload()
  await expect(page.getByRole('main').getByRole('button', { name: /^Mark done/ }).first()).toBeVisible()

  // Demo time moves in one tap: 15 minutes on, then straight to the next departure.
  await openSimulate(page)
  const time = page.getByLabel('Current time')
  for (const [button, expected] of [[/^\+15 min$/, '08:15'], [/^Next departure, 08:50$/, '08:50']] as const) {
    const moved = page.waitForResponse((r) => r.url().endsWith(`/v1/trips/${TRIP}/demo/clock`) && r.request().method() === 'POST')
    await page.getByRole('button', { name: button }).click()
    expect((await moved).ok()).toBe(true)
    await expect(time).toHaveValue(expected)
  }
  await page.keyboard.press('Escape')

  // Add a task on the Plan tab: the day re-plans by itself.
  await page.goto('/plan')
  await page.getByRole('button', { name: 'Add a task' }).click()
  const form = page.getByRole('dialog')
  await form.getByLabel('Title', { exact: true }).fill('Pick up documents')
  await form.getByLabel('Place', { exact: true }).fill('Jayanagar')
  await form.getByRole('list', { name: 'Places found' }).getByRole('button', { name: /University admin office/ }).first().click()
  const planned = page.waitForResponse((r) => r.url().includes(`/v1/trips/${TRIP}/tasks`) && r.request().method() === 'POST')
  await form.getByRole('button', { name: 'Add this task' }).click()
  expect(((await (await planned).json()) as { jobId: string | null }).jobId).toBeTruthy()
  await expect(page.getByRole('region', { name: /Notifications/ }).getByRole('listitem').filter({ hasText: 'Your day is updated' })).toBeVisible({ timeout: 30_000 })

  // Today shows it: on the timeline, or with the reason it couldn't fit. It never just vanishes.
  await page.goto('/')
  await expect(page.getByRole('main').getByText('Pick up documents').first()).toBeVisible()
})

test('ride a leg: the live dot follows the road, and Roo says when you arrive', async ({ page }) => {
  test.setTimeout(150_000)
  await planFreshDay(page)
  await setClock(page, '08:00')
  await openSimulate(page)
  await page.getByRole('button', { name: 'Simulate the ride to the meeting' }).click()
  // Live distance and time to go on the Next card, then the arrival alert.
  await expect(page.getByRole('main').getByText(/to go, about/).first()).toBeVisible({ timeout: 15_000 })
  const toasts = page.getByRole('region', { name: /Notifications/ })
  await expect(toasts.getByRole('listitem').filter({ hasText: 'You’ve arrived at the meeting' }).or(toasts.getByRole('listitem').filter({ hasText: "You've arrived at the meeting" }))).toBeVisible({
    timeout: 70_000,
  })
})

test("a task that can't fit today moves to tomorrow in one tap", async ({ page }) => {
  test.setTimeout(120_000)
  await planFreshDay(page)
  // A second fixed meeting at 13:30 leaves the bank no gap today.
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  const added = await page.request.post(`/v1/trips/${TRIP}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: 'Client call', placeId: 'jayanagar-office', durationMin: 60, fixedStart: '2026-10-14T13:30:00+05:30', idempotencyKey: `e2e-call-${Date.now()}` },
  })
  expect(added.ok()).toBe(true)
  await page.reload()
  const card = page.getByRole('region', { name: /in today’s plan/ })
  await expect(card.getByText(/The bank needs 2 h 30 min/)).toBeVisible({ timeout: 20_000 })
  await card.getByRole('listitem').filter({ hasText: 'Bank' }).getByRole('button', { name: 'Move to Thursday' }).click()
  await expect(page.getByRole('region', { name: /Notifications/ }).getByRole('listitem').filter({ hasText: 'The bank moved to Thursday' })).toBeVisible({ timeout: 30_000 })
})

test('book a train ticket and a cab (simulated)', async ({ page }) => {
  test.setTimeout(150_000)
  await planFreshDay(page)
  const main = page.getByRole('main')

  // Tomorrow's train offers a ticket.
  await main.getByRole('button', { name: 'Book train ticket' }).first().click()
  let sheet = page.getByRole('dialog', { name: /Book your train ticket/ })
  await expect(sheet.getByText(/nothing real is booked/)).toBeVisible()
  await sheet.getByLabel('Where to?').fill('Chennai')
  await sheet.getByRole('button', { name: 'Find trains' }).click()
  const firstClass = sheet.getByRole('radio').first()
  await expect(firstClass).toBeAttached({ timeout: 20_000 })
  await firstClass.focus()
  await page.keyboard.press('Space')
  await sheet.getByRole('button', { name: /^Continue with/ }).click()
  await sheet.getByLabel('Passenger 1').fill('Arjun Mehta')
  await sheet.getByLabel('Age').fill('34')
  await sheet.getByRole('button', { name: 'Review and pay' }).click()
  await sheet.getByRole('button', { name: /^Pay ₹/ }).click()
  const ticket = page.getByRole('dialog', { name: 'Your train ticket' })
  await expect(ticket.getByText(/^PNR \d{10}$/)).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('Escape')
  await expect(main.getByRole('button', { name: /^PNR \d{10}/ })).toBeVisible()

  // A leg offers a cab; the ride shows its OTP.
  await main.getByRole('button', { name: 'Book a cab' }).first().click()
  sheet = page.getByRole('dialog', { name: 'Book a ride' })
  const firstRide = sheet.getByRole('radio').first()
  await expect(firstRide).toBeVisible({ timeout: 20_000 })
  await firstRide.check()
  await sheet.getByRole('button', { name: /^Book .* \(demo\)$/ }).click()
  const ride = page.getByRole('dialog', { name: 'Your ride' })
  await expect(ride.getByText('OTP for the driver')).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('Escape')
  await expect(main.getByRole('button', { name: /OTP \d{4}/ })).toBeVisible()
})

test('Roo rides the timeline: tap it to add a task', async ({ page }) => {
  test.setTimeout(120_000)
  await planFreshDay(page)
  await page.getByRole('button', { name: 'Roo, your travel companion. Add a task or change this stop' }).click()
  const menu = page.getByRole('dialog', { name: 'Roo' })
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: 'Add a task' }).click()
  // Describe-your-day with the AI helper on; the task form (on Plan) with it off.
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByLabel('What do you need to do?').or(sheet.getByLabel('Title', { exact: true }))).toBeVisible()
})

test('running late, reroute, then undo', async ({ page }) => {
  test.setTimeout(120_000)
  await planFreshDay(page)
  await setClock(page, '10:55')

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
