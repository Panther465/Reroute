import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

// Needs the full stack with DEMO_LOGIN=true. Skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

async function noSeriousIssues(page: Page, name: string) {
  // Let the screen's fade-in finish: axe measures contrast with the opacity of the moment.
  await page.waitForFunction(() => {
    const main = document.getElementById('main')
    return (!main || getComputedStyle(main).opacity === '1') && document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity)
  })
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
  // Name each failing element and why, so a failure in CI explains itself.
  const found = serious.flatMap((v) => v.nodes.slice(0, 5).map((n) => `${name}: ${v.id} at ${n.target.join(' ')}: ${n.any[0]?.message ?? n.failureSummary ?? ''}`))
  expect(found).toEqual([])
}

async function signInAsDemo(page: Page) {
  await page.goto('/signin')
  await page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(page).not.toHaveURL(/signin/)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme })

    test('sign in screen', async ({ page }) => {
      await page.goto('/signin')
      await expect(page.getByRole('heading', { name: 'Reroute' })).toBeVisible()
      await noSeriousIssues(page, 'signin')
    })

    test('main screens', async ({ page }, info) => {
      await signInAsDemo(page)
      // Make sure the sample day has a plan to show.
      await page.goto('/plan')
      const plan = page.getByRole('button', { name: /Plan my day/ })
      if (await plan.isVisible()) {
        await plan.click()
        await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
      }
      for (const [path, heading] of [
        ['/', 'Bengaluru'],
        ['/plan', /trip/i],
        ['/raasta', 'Raasta'],
        ['/me', 'Me'],
        ['/summary', /in Bengaluru|No day/],
        ['/leg/2', /to/],
      ] as const) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: heading }).first()).toBeVisible({ timeout: 15_000 })
        await noSeriousIssues(page, path)
        await page.screenshot({ path: `test-results/screens/${info.project.name}-${scheme}${path.replace(/\//g, '_') || '_today'}.png`, fullPage: true })
      }
    })

    test('running late sheet is reachable by keyboard', async ({ page }) => {
      await signInAsDemo(page)
      await page.goto('/')
      const late = page.getByRole('button', { name: 'Running late' })
      if (!(await late.isEnabled())) test.skip(true, 'No open task to report a delay on')
      await late.focus()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('dialog')).toBeVisible()
      await noSeriousIssues(page, 'running-late')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toBeHidden()
      await expect(late).toBeFocused()
    })
  })
}
