import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Turn by turn on the sample day: the leg's steps, following the phone's position along it, and Google Maps.
// Needs the full stack with DEMO_LOGIN=true; works with routing on or off (the metro is drawn station to
// station either way). Skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

const TRIP = 'trip-001'
const HOTEL = { longitude: 77.5713, latitude: 12.9767, accuracy: 10 }
// On the platform at Majestic, where the walk ends and the Purple Line begins.
const MAJESTIC = { longitude: 77.572806, latitude: 12.97567, accuracy: 10 }

test.use({ geolocation: HOTEL, permissions: ['geolocation'] })

async function resetDemo(page: Page) {
  const login = await page.request.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  const res = await page.request.post(`/v1/trips/${TRIP}/demo/reset`, { headers: { Authorization: `Bearer ${token}` }, data: { idempotencyKey: `e2e-nav-${Date.now()}` } })
  expect(res.ok()).toBe(true)
}

test.afterEach(async ({ page }) => resetDemo(page))

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme })

    test('turn by turn follows you along the leg, with Google Maps a tap away', async ({ page, context }) => {
      test.setTimeout(120_000)
      await page.goto('/signin')
      await page.getByRole('button', { name: 'Use the demo account' }).click()
      await expect(page).not.toHaveURL(/signin/)
      await resetDemo(page)
      await page.goto('/plan')
      await page.getByRole('button', { name: /^Plan my day/ }).click()
      await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })

      await page.getByRole('link', { name: 'Turn by turn' }).first().click()
      await expect(page.getByRole('heading', { level: 1, name: 'To Meeting' })).toBeVisible()
      const steps = page.getByRole('region', { name: 'Every step' })
      // The server draws the legs after planning: the steps appear once it has.
      await expect(steps.getByRole('listitem').filter({ hasText: 'Take the Purple Line from Nadaprabhu Kempegowda Station, Majestic towards Whitefield (Kadugodi)' })).toHaveCount(1, {
        timeout: 30_000,
      })

      await page.getByRole('button', { name: 'Follow my location' }).click()
      await context.setGeolocation(MAJESTIC)
      await expect(steps.locator('li[aria-current="step"]')).toContainText('Get off at Pattandur Agrahara', { timeout: 15_000 })
      const google = new URL((await page.getByRole('link', { name: /Open in Google Maps/ }).getAttribute('href'))!)
      expect(google.searchParams.get('travelmode')).toBe('transit')
      expect(google.searchParams.get('destination')).toBe('12.9855,77.7318')

      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
      expect(scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([])
    })
  })
}
