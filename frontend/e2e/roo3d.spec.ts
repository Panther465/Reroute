import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Rico in 3D. Headless browsers draw WebGL in software, which the app treats as too slow and shows Rico's stills
// (pictures of the same 3D Rico) instead; this file turns the live 3D Rico on (the reroute.roo3d override) and
// gives the browser software WebGL, so the live path is checked too. Needs the full stack with DEMO_LOGIN=true.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } })

async function liveRico(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('reroute.roo3d', 'on')
    } catch {
      /* storage blocked */
    }
  })
}

async function signIn(page: Page) {
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`Rico in 3D greets a traveller, and the screen stays accessible (${scheme})`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.emulateMedia({ colorScheme: scheme })
    await liveRico(page)
    const errors: string[] = []
    // The service worker can't register over the local stack's self-signed certificate: not Rico's doing.
    page.on('pageerror', (e) => !/ServiceWorker/.test(String(e)) && errors.push(String(e)))
    await signIn(page)
    await page.goto('/welcome')
    await expect(page.getByRole('group', { name: 'Answers' })).toBeVisible({ timeout: 40_000 })

    // The live 3D Rico has drawn and taken over from its still; its canvas is decoration.
    const roo = page.locator('[data-roo3d]').first()
    await expect(roo).toHaveAttribute('data-roo3d', 'ready', { timeout: 20_000 })
    await expect(roo.locator('canvas')).toHaveCount(1)
    await expect(roo.locator('canvas')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.getByRole('button', { name: 'Rico. Poke it' })).toBeVisible()

    await page.waitForTimeout(600)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
    expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id} at ${n.target.join(' ')}`))).toEqual([])
    expect(errors).toEqual([])
  })
}

test('every Rico is the 3D one: live where it stands alone, its stills beside each line and with reduced motion', async ({ page, isMobile }) => {
  test.setTimeout(90_000)
  await liveRico(page)
  await signIn(page)
  await page.goto('/')

  // On Today, Rico on the Now line, and on a desktop the Ask Rico button: both drawn live (Rico draws only while
  // it's on screen, and on a phone the Now line can be further down).
  const onToday = page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' })
  await onToday.scrollIntoViewIfNeeded()
  await expect(onToday.locator('[data-roo3d]')).toHaveAttribute('data-roo3d', 'ready', { timeout: 20_000 })
  if (!isMobile) await expect(page.getByRole('button', { name: 'Ask Rico' }).locator('[data-roo3d]')).toHaveAttribute('data-roo3d', 'ready', { timeout: 20_000 })

  // In the chat, Rico at the top is live; beside each of its lines is its still, a picture of the same 3D Rico.
  await onToday.click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  await expect(chat.locator('header [data-roo3d]')).toHaveAttribute('data-roo3d', 'ready', { timeout: 20_000 })
  const beside = chat.getByRole('log').locator('img[src*="roo-happy"]').first()
  await expect(beside).toBeAttached({ timeout: 20_000 })
  expect(await beside.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)

  // With reduced motion nothing is drawn live: every Rico is its still.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(onToday.locator('[data-roo3d]')).toHaveAttribute('data-roo3d', 'still', { timeout: 20_000 })
  for (const rico of await page.locator('[data-roo3d]').all()) await expect(rico).toHaveAttribute('data-roo3d', 'still')
  await expect(onToday.locator('img[src*="roo-"]')).toHaveCount(1)
  await expect(page.locator('[data-roo3d] canvas')).toHaveCount(0)
})
