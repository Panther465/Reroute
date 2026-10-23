import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Roo's agent end to end: one message, one card, Do all, the day changes, then Undo. Needs the full stack
// with DEMO_LOGIN=true and AI_HELPER_ENABLED=true, plus a Gemini key or Roo's scripted model (ROO_FAKE_LLM,
// as CI runs it). Skipped when E2E_BASE_URL is unset or Roo's agent is off.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

const TRIP = 'trip-001'

async function api(page: Page) {
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  return { Authorization: `Bearer ${token}` }
}

async function resetDemo(page: Page) {
  const res = await page.request.post(`/v1/trips/${TRIP}/demo/reset`, { headers: await api(page), data: { idempotencyKey: `e2e-agent-reset-${Date.now()}` } })
  expect(res.ok()).toBe(true)
}

test.afterEach(async ({ page }) => resetDemo(page))

test('Rico does three things from one message, on one card, and Undo takes them back', async ({ page }) => {
  test.setTimeout(150_000)
  // Signed in on the page first: an API sign-in shares the browser's cookies, and /signin would skip ahead.
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
  const headers = await api(page)
  const me = (await (await page.request.get('/v1/me', { headers })).json()) as { features?: { agent?: boolean } }
  test.skip(!me.features?.agent, "Rico's agent is off on this server (AI_HELPER_ENABLED with a Gemini key, or ROO_FAKE_LLM)")
  await resetDemo(page)

  await page.goto('/plan')
  await page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })

  await page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' }).click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  await chat.getByLabel('Message Rico').fill('Skip the university office, book a cab to the bank and go dark')
  await chat.getByRole('button', { name: 'Send' }).click()

  // One card with everything on it; nothing has changed yet.
  const card = chat.getByRole('group', { name: 'Rico’s card: 3 things' })
  await expect(card).toBeVisible({ timeout: 60_000 })
  // In whatever order the model put them (Gemini, or the scripted model in CI).
  for (const step of [/Skip “University office”/, /Book a .* to Bank/, /Switch to dark mode/]) await expect(card.getByRole('listitem').filter({ hasText: step })).toHaveCount(1)
  await expect(chat.getByRole('log')).toContainText('Checked rides to Bank')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  const scan = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([])

  await card.getByRole('button', { name: 'Do all 3' }).click()
  // Each step says how it went (to a screen reader too), and the card offers Undo.
  await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 45_000 })
  await expect(card.getByRole('listitem')).toHaveText([/Done$/, /Done$/, /Done$/])
  await expect(chat.getByRole('log')).toContainText('All 3 done.')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const bookings = (await (await page.request.get(`/v1/trips/${TRIP}/bookings`, { headers })).json()) as { status: string }[]
  expect(bookings.map((b) => b.status)).toEqual(['confirmed'])

  await card.getByRole('button', { name: 'Undo' }).click()
  await expect(card.getByText('Undone')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  const after = (await (await page.request.get(`/v1/trips/${TRIP}/bookings`, { headers })).json()) as { status: string }[]
  expect(after.map((b) => b.status)).toEqual(['cancelled'])
})
