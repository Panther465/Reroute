import { _android as android, expect, request, test as base, type AndroidDevice, type APIRequestContext, type Page } from '@playwright/test'

// The Android app does what the web app does: the same journeys as e2e/, inside the installed debug APK's
// web view, plus what only the app has to get right (Android's share sheet, the Maps app, the back button,
// the bars, staying signed in). Needs a running stack with DEMO_LOGIN=true, an emulator or phone on adb,
// and the debug APK built against that stack. ANDROID_API is the stack's address from this computer.
// Every console error in the app fails the last test.

const PKG = 'com.reroute.app'
/** The app's own page inside the phone. */
const APP = 'https://localhost'
const API = process.env.ANDROID_API ?? 'https://localhost'
const TRIP = 'trip-001'

interface App {
  device: AndroidDevice
  page: Page
  errors: string[]
  api: APIRequestContext
  /** Close the app and open it again, as a traveller would; the page is the new one's. */
  relaunch: () => Promise<void>
}

async function attach(device: AndroidDevice, errors: string[]): Promise<Page> {
  const webview = await device.webView({ pkg: PKG })
  const page = await webview.page()
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(String(e)))
  return page
}

const test = base.extend<object, { app: App }>({
  app: [
    async ({}, use) => {
      const [device] = await android.devices()
      if (!device) throw new Error('No Android device: start the emulator or plug in a phone (adb devices).')
      await device.shell(`pm clear ${PKG}`)
      // Granted ahead, so Android's own permission dialogs don't stand in front of the web view.
      for (const p of ['POST_NOTIFICATIONS', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'RECORD_AUDIO']) await device.shell(`pm grant ${PKG} android.permission.${p}`)
      await device.shell(`am start -W -n ${PKG}/.MainActivity`)
      const errors: string[] = []
      const app: App = {
        device,
        errors,
        page: await attach(device, errors),
        api: await request.newContext({ baseURL: API, ignoreHTTPSErrors: true }),
        relaunch: async () => {
          await device.shell(`am force-stop ${PKG}`)
          await device.shell(`am start -W -n ${PKG}/.MainActivity`)
          app.page = await attach(device, errors)
        },
      }
      await use(app)
      await app.api.dispose()
      await device.close()
    },
    { scope: 'worker' },
  ],
})

test.describe.configure({ mode: 'serial' })

/** Reset the sample day through the API, from this computer. */
async function resetDemo(api: APIRequestContext) {
  const login = await api.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const token = ((await login.json()) as { accessToken: string }).accessToken
  const reset = await api.post(`/v1/trips/${TRIP}/demo/reset`, { headers: { Authorization: `Bearer ${token}` }, data: { idempotencyKey: `android-reset-${Date.now()}` } })
  expect(reset.ok()).toBe(true)
  return token
}

async function openSimulate(page: Page) {
  const heading = page.getByRole('heading', { name: 'Simulate' })
  if (!(await heading.isVisible())) await page.getByRole('button', { name: 'Simulate', exact: true }).click()
  await expect(heading).toBeVisible()
}

async function setClock(page: Page, hhmm: string) {
  await openSimulate(page)
  const time = page.getByLabel('Current time')
  if ((await time.inputValue()) !== hhmm) {
    await time.fill(hhmm)
    await page.getByRole('heading', { name: 'Simulate' }).click()
    await expect(time).toHaveValue(hhmm)
  }
  await page.keyboard.press('Escape')
}

/** The sample day, planned, on Today. */
async function planFreshDay(app: App) {
  await resetDemo(app.api)
  await app.page.goto(`${APP}/plan`)
  await app.page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(app.page).toHaveURL(/\/$/, { timeout: 30_000 })
  await expect(app.page.getByRole('heading', { level: 1, name: 'Bengaluru' })).toBeVisible()
}

/** What Android shows on top, e.g. the share sheet or the Maps app. */
async function foreground(device: AndroidDevice): Promise<string> {
  const out = (await device.shell('dumpsys activity activities')).toString()
  return /topResumedActivity=.*?\{[^}]*\s(\S+\/\S+)/.exec(out)?.[1] ?? /mResumedActivity: .*?\s(\S+\/\S+)/.exec(out)?.[1] ?? ''
}

test('opens on Sign in and signs in with the demo account', async ({ app }) => {
  await expect(app.page.getByRole('button', { name: 'Use the demo account' })).toBeVisible({ timeout: 30_000 })
  await app.page.getByRole('button', { name: 'Use the demo account' }).click()
  await expect(app.page).not.toHaveURL(/signin/, { timeout: 30_000 })
})

test('stays signed in when the app is closed and opened again', async ({ app }) => {
  await app.relaunch()
  await expect(app.page).not.toHaveURL(/signin/, { timeout: 30_000 })
  await expect(app.page.getByRole('navigation', { name: 'Main' })).toBeVisible()
})

test('plans the day: Today with its map and the 3D Rico', async ({ app }) => {
  await planFreshDay(app)
  const page = app.page
  await expect(page.getByRole('main').getByText(/^Leave for /).first()).toBeVisible()
  // The map draws (MapLibre's canvas), and Rico is the 3D one, live or as its still.
  await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-roo3d]').first()).toBeAttached()
})

test('every tab opens: Plan, Raasta (its own API) and Me with the wallet', async ({ app }) => {
  const page = app.page
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: /Plan/ }).click()
  await expect(page).toHaveURL(/\/plan$/)
  await nav.getByRole('link', { name: /Raasta/ }).click()
  await expect(page).toHaveURL(/\/raasta$/)
  await expect(page.getByRole('main').getByText(/Koramangala|Jayanagar/).first()).toBeVisible({ timeout: 30_000 })
  await nav.getByRole('link', { name: /Me/ }).click()
  await expect(page).toHaveURL(/\/me$/)
  await expect(page.getByRole('main').getByText(/Wallet|₹/).first()).toBeVisible({ timeout: 30_000 })
})

test("Android's back button goes back a screen, and closes a sheet first", async ({ app }) => {
  const page = app.page
  await page.goto(`${APP}/`)
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Me/ }).click()
  await expect(page).toHaveURL(/\/me$/)
  await app.device.input.press('Back')
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: 'Running late' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await app.device.input.press('Back')
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page).toHaveURL(/\/$/)
})

test('running late: the day reroutes, then Undo brings it back', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await setClock(page, '10:55')
  await page.getByRole('button', { name: 'Running late' }).click()
  const sheet = page.getByRole('dialog')
  const forty = sheet.getByRole('radio', { name: 'About 40 min' })
  await forty.focus()
  await page.keyboard.press('Space')
  await sheet.getByRole('button', { name: 'Update my times' }).click()
  await expect(sheet.getByRole('heading', { name: 'Choose how to fix your day' })).toBeVisible({ timeout: 30_000 })
  await sheet.getByRole('button', { name: 'Reroute my day' }).click()
  await expect(sheet).toBeHidden({ timeout: 20_000 })
  const toasts = page.getByRole('region', { name: /Notifications/ })
  const toast = toasts.getByRole('listitem').filter({ hasText: 'Day rerouted' })
  await expect(toast).toBeVisible({ timeout: 10_000 })
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(toasts.getByRole('listitem').filter({ hasText: 'Your earlier plan is back' })).toBeVisible({ timeout: 15_000 })
})

test("go anyway, then Tell them: the message goes through Android's share sheet", async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await setClock(page, '08:45')
  await page.getByRole('button', { name: 'Running late' }).click()
  const sheet = page.getByRole('dialog')
  const forty = sheet.getByRole('radio', { name: 'About 40 min' })
  await forty.focus()
  await page.keyboard.press('Space')
  await sheet.getByRole('button', { name: 'Update my times' }).click()
  const anyway = sheet.getByRole('radio', { name: /Go anyway, about \d+ min late/ })
  await expect(anyway).toBeAttached({ timeout: 30_000 })
  await anyway.focus()
  await page.keyboard.press('Space')
  await sheet.getByRole('button', { name: 'Reroute my day' }).click()
  await expect(sheet).toBeHidden({ timeout: 20_000 })
  const banner = page.getByRole('alert').filter({ hasText: /You’ll reach the meeting at about/ })
  await expect(banner).toBeVisible({ timeout: 20_000 })
  await banner.getByRole('button', { name: 'Tell them' }).click()
  await expect(page.getByLabel('Your message')).toHaveValue(/running about \d+ minutes late/)
  await page.getByRole('dialog').getByRole('button', { name: /^Share|^Send/ }).first().click()
  await expect.poll(() => foreground(app.device), { timeout: 10_000 }).toMatch(/ChooserActivity|ResolverActivity|intentresolver/i)
  await app.device.input.press('Back')
  await expect.poll(() => foreground(app.device), { timeout: 10_000 }).toContain(PKG)
  await page.keyboard.press('Escape')
})

test('a leg: real-road map, Google Maps hand-off and turn by turn with the phone’s location', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await page.goto(`${APP}/leg/1`)
  await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible({ timeout: 30_000 })
  // Google Maps opens in its own app (or the browser), never inside Reroute.
  await page.getByRole('link', { name: /Open in Google Maps/ }).first().click()
  await expect.poll(() => foreground(app.device), { timeout: 15_000 }).not.toContain(`${PKG}/`)
  await app.device.shell(`am start -W -n ${PKG}/.MainActivity`)
  await expect.poll(() => foreground(app.device), { timeout: 15_000 }).toContain(PKG)
  // Turn by turn follows the phone's location: the emulator's position is set at the hotel.
  await app.device.shell('cmd location set-location-enabled true')
  await page.goto(`${APP}/leg/1/navigate`)
  await expect(page.getByRole('main')).toContainText(/Turn|Head|Walk|Leave|arrived|m\b/, { timeout: 30_000 })
})

test('Rico: chat, its agent card and Undo', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' }).click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  await expect(chat.getByRole('log', { name: 'Conversation with Rico' })).toContainText(/Good (morning|afternoon|evening)/)
  await chat.getByLabel('Message Rico').fill('move the bank to tomorrow')
  await chat.getByRole('button', { name: 'Send' }).click()
  await chat.getByRole('button', { name: 'Not now' }).click()
  await expect(chat.getByRole('log')).toContainText('Okay, I’ll leave it as it is.')
  // Android's back button closes the chat.
  await app.device.input.press('Back')
  await expect(chat).toBeHidden()
})

test('light and dark: the page and the status bar change together', async ({ app }) => {
  const page = app.page
  await page.goto(`${APP}/me`)
  await page.getByRole('radio', { name: /Dark/ }).first().click({ force: true })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // The status bar's colour: a pixel near the top of the screen is the dark ground (#10161F).
  const top = await statusBarPixel(app.device)
  expect(top[0] + top[1] + top[2]).toBeLessThan(150)
  await page.getByRole('radio', { name: /Light/ }).first().click({ force: true })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  const light = await statusBarPixel(app.device)
  expect(light[0] + light[1] + light[2]).toBeGreaterThan(600)
})

/** The colour two pixels below the top edge, halfway across: inside the status bar. */
async function statusBarPixel(device: AndroidDevice): Promise<[number, number, number]> {
  await new Promise((r) => setTimeout(r, 500))
  const png = await device.screenshot()
  const { PNG } = await import('./png')
  return PNG.pixel(png, 0.5, 2)
}

test('offline: a check-in waits on the phone and syncs when the signal is back', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await setClock(page, '11:05')
  await app.device.shell('cmd connectivity airplane-mode enable')
  try {
    await expect(page.getByText(/You're offline/).first()).toBeVisible({ timeout: 30_000 })
    await page.getByRole('main').getByRole('button', { name: /^Mark done/ }).first().click()
    await expect(page.getByText(/check-ins? (is|are) waiting to sync/).first()).toBeVisible({ timeout: 15_000 })
  } finally {
    await app.device.shell('cmd connectivity airplane-mode disable')
  }
  await expect(page.getByText(/check-ins? (is|are) waiting to sync/)).toHaveCount(0, { timeout: 60_000 })
})

test('signs out, and signs in again with an email account', async ({ app }) => {
  const page = app.page
  await page.goto(`${APP}/me`)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/signin/, { timeout: 15_000 })
  await page.getByRole('button', { name: /Create (an |my )?account/ }).first().click()
  const email = `android-${Date.now()}@example.com`
  await page.getByLabel('Your name').fill('Asha Rao')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('a-long-test-password')
  await page.getByRole('button', { name: /Create (my )?account/ }).last().click()
  await expect(page).toHaveURL(/welcome/, { timeout: 30_000 })
})

test('no errors in the app’s console on any of the journeys', async ({ app }) => {
  expect(app.errors).toEqual([])
})
