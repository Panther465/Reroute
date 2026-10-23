import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Roo in 3D. Headless browsers draw WebGL in software, which the app treats as too slow and shows the flat
// Roo instead; this file turns the 3D Roo on (the reroute.roo3d override) and gives the browser software
// WebGL, so the 3D path is checked too. Needs the full stack with DEMO_LOGIN=true.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } })

for (const scheme of ['light', 'dark'] as const) {
  test(`Roo in 3D greets a traveller, and the screen stays accessible (${scheme})`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.emulateMedia({ colorScheme: scheme })
    await page.addInitScript(() => {
      try {
        localStorage.setItem('reroute.roo3d', 'on')
      } catch {
        /* storage blocked */
      }
    })
    const errors: string[] = []
    // The service worker can't register over the local stack's self-signed certificate: not Roo's doing.
    page.on('pageerror', (e) => !/ServiceWorker/.test(String(e)) && errors.push(String(e)))
    await page.goto('/signin')
    await page.getByRole('button', { name: 'Use the demo account' }).click()
    await expect(page).not.toHaveURL(/signin/)
    await page.goto('/welcome')
    await expect(page.getByRole('group', { name: 'Answers' })).toBeVisible({ timeout: 40_000 })

    // The 3D Roo has drawn and taken over from the flat one; its canvas is decoration.
    const roo = page.locator('[data-roo3d]').first()
    await expect(roo).toHaveAttribute('data-roo3d', 'ready', { timeout: 20_000 })
    await expect(roo.locator('canvas')).toHaveCount(1)
    await expect(roo.locator('canvas')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.getByRole('button', { name: 'Roo. Poke it' })).toBeVisible()

    await page.waitForTimeout(600)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
    expect(serious.flatMap((v) => v.nodes.map((n) => `${v.id} at ${n.target.join(' ')}`))).toEqual([])
    expect(errors).toEqual([])
  })
}
