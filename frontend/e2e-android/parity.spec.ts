import path from 'node:path'
import { _android as android, expect, request, test as base, type AndroidDevice, type Page } from '@playwright/test'

// The Android app does what the web app does: the same journeys as e2e/, inside the installed debug APK's
// web view, plus what only the app has to get right (Android's share sheet, the Maps app, the back button,
// the bars, staying signed in). Needs a running stack with DEMO_LOGIN=true, an emulator or phone on adb,
// and the debug APK built against that stack (VITE_API_BASE). Every console error in the app fails, but for
// the few listed in EXPECTED; so does every error line in the app's own Logcat, but for LOGCAT_EXPECTED.

const PKG = 'com.reroute.app'
/** The app's own page inside the phone. */
const APP = 'https://localhost'
const TRIP = 'trip-001'

/** A console error, and the journey it happened in. */
interface Logged {
  journey: string
  text: string
}

/** The journey running now, so each console error says where it came from. */
let journey = ''
/** The API the app calls, as the app's own requests show it. */
let apiOrigin = ''

interface App {
  device: AndroidDevice
  page: Page
  errors: Logged[]
  /** Close the app and open it again, as a traveller would; the page is the new one's. */
  relaunch: () => Promise<void>
  /** Connect to the app's page afresh, after Android handed a link to another app (the old handle waits forever). */
  reattach: () => Promise<void>
  /** Let go of the page: Playwright keeps a page it drives "visible", even with the app in the background. */
  detach: () => Promise<void>
}

/** The app's API as this computer reaches it: the emulator's 10.0.2.2 is this computer's localhost. */
function apiFromComputer() {
  expect(apiOrigin).toBeTruthy()
  const url = new URL(apiOrigin)
  if (url.hostname === '10.0.2.2') url.hostname = 'localhost'
  return url.origin
}

async function attach(device: AndroidDevice, errors: Logged[]): Promise<Page> {
  const webview = await device.webView({ pkg: PKG })
  const page = await webview.page()
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    // A failed load names its request, so a dropped connection says which one it was.
    const url = m.text().startsWith('Failed to load resource') ? m.location().url : ''
    errors.push({ journey, text: url ? `${m.text()} (${new URL(url).pathname})` : m.text() })
  })
  page.on('pageerror', (e) => errors.push({ journey, text: String(e) }))
  page.on('request', (r) => {
    if (!apiOrigin && r.url().includes('/v1/')) apiOrigin = new URL(r.url()).origin
  })
  // Which request a "Failed to load resource" line was about.
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push({ journey, text: `HTTP ${r.status()} ${r.request().method()} ${r.url()}` })
  })
  return page
}

const test = base.extend<object, { app: App }>({
  app: [
    async ({}, use) => {
      const [device] = await android.devices()
      if (!device) throw new Error('No Android device: start the emulator or plug in a phone (adb devices).')
      // A phone as if new: no app data, and none of the slips earlier runs saved.
      await device.shell(`pm clear ${PKG}`)
      await device.shell('rm -rf /sdcard/Documents/Reroute')
      // Logcat from this run only, for the last test.
      await device.shell('logcat -c')
      // Granted ahead, so Android's own permission dialogs don't stand in front of the web view.
      for (const p of ['POST_NOTIFICATIONS', 'ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'RECORD_AUDIO']) await device.shell(`pm grant ${PKG} android.permission.${p}`)
      await device.shell(`am start -W -n ${PKG}/.MainActivity`)
      const errors: Logged[] = []
      const app: App = {
        device,
        errors,
        page: await attach(device, errors),
        relaunch: async () => {
          await app.device.shell(`am force-stop ${PKG}`)
          await app.device.shell(`am start -W -n ${PKG}/.MainActivity`)
          app.page = await attach(app.device, errors)
        },
        reattach: async () => {
          // A new connection: the device's own one keeps handing back the page that waits.
          await app.device.close()
          const [again] = await android.devices()
          app.device = again
          app.page = await attach(again, errors)
        },
        detach: async () => {
          await app.device.close()
          app.device = (await android.devices())[0]
        },
      }
      await use(app)
      await app.device.close()
    },
    { scope: 'worker' },
  ],
})

test.describe.configure({ mode: 'serial' })
test.beforeEach(({}, info) => {
  journey = info.title
})

/** A screen of the app by its path. The page is ready once its structure is: an SPA, it draws from there. */
async function open(page: Page, path: string) {
  await page.goto(`${APP}${path}`, { waitUntil: 'domcontentloaded' })
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

/** The sample day afresh and planned, on Today: reset in the app's own Simulate panel, as the browser test does. */
async function planFreshDay(app: App) {
  const page = app.page
  await open(page, '/')
  await openSimulate(page)
  const reset = page.waitForResponse((r) => r.url().endsWith(`/v1/trips/${TRIP}/demo/reset`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Reset the demo' }).click()
  expect((await reset).ok()).toBe(true)
  await expect(page).toHaveURL(/\/plan$/)
  await page.getByRole('button', { name: /^Plan my day/ }).click()
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 })
  await expect(page.getByRole('heading', { level: 1, name: 'Bengaluru' })).toBeVisible()
}

/** Android's back button, as the traveller presses it (through Android itself, no test driver on the phone). */
async function pressBack(device: AndroidDevice) {
  await device.shell('input keyevent KEYCODE_BACK')
}

/** Back from Android's share sheet to Reroute. Android ignores Back while the sheet is still sliding in. */
async function backToApp(device: AndroidDevice) {
  for (let i = 0; i < 3 && !(await foreground(device)).includes(PKG); i++) {
    await new Promise((r) => setTimeout(r, 1000))
    await pressBack(device)
  }
  await expect.poll(() => foreground(device), { timeout: 10_000 }).toContain(PKG)
}

/** Where Reroute's screen is in its lifecycle: RESUMED on screen, then PAUSED, STOPPING and STOPPED as it leaves. */
async function activityState(device: AndroidDevice): Promise<string> {
  const out = (await device.shell('dumpsys activity activities')).toString()
  return new RegExp(`${PKG.replace(/\./g, '\\.')}/\\.MainActivity[\\s\\S]*?\\bstate=(\\w+)`).exec(out)?.[1] ?? ''
}

/** Where the app's web view starts on the screen, in device pixels, from Android's own layout dump (below the
 *  status bar). */
async function webViewOrigin(device: AndroidDevice): Promise<{ x: number; y: number }> {
  for (let i = 0; i < 3; i++) {
    await device.shell('uiautomator dump /sdcard/reroute-ui.xml')
    const xml = (await device.shell('cat /sdcard/reroute-ui.xml')).toString()
    const found = /class="android\.webkit\.WebView"[^>]*?bounds="\[(\d+),(\d+)\]/.exec(xml)
    if (found) {
      await device.shell('rm /sdcard/reroute-ui.xml')
      return { x: Number(found[1]), y: Number(found[2]) }
    }
  }
  throw new Error('Android showed no web view')
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
  await open(page, '/')
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Me/ }).click()
  await expect(page).toHaveURL(/\/me$/)
  await pressBack(app.device)
  await expect(page).toHaveURL(/\/$/)
  await page.getByRole('button', { name: 'Running late' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await pressBack(app.device)
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
  await backToApp(app.device)
  await page.keyboard.press('Escape')
})

test('a leg: real-road map, Google Maps hand-off and turn by turn with the phone’s location', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await open(page, '/leg/1')
  await expect(page.locator('canvas.maplibregl-canvas').first()).toBeVisible({ timeout: 30_000 })
  // Google Maps opens in its own app (or the browser), never inside Reroute.
  // The tap hands the link to Android, so the web view never navigates: tap without waiting for one.
  await page.getByRole('link', { name: /Google Maps/ }).first().evaluate((a: HTMLAnchorElement) => a.click())
  await expect.poll(() => foreground(app.device), { timeout: 15_000 }).not.toContain(`${PKG}/`)
  // Switching back (Reroute's icon) finds it on the same screen.
  await app.device.shell(`am start -n ${PKG}/.MainActivity`)
  await expect.poll(() => foreground(app.device), { timeout: 10_000 }).toContain(PKG)
  await app.reattach()
  await expect(app.page).toHaveURL(/\/leg\/1$/)
  // Turn by turn follows the phone's location: the emulator's position is set at the hotel.
  await app.device.shell('cmd location set-location-enabled true')
  await open(app.page, '/leg/1/navigate')
  await expect(app.page.getByRole('main')).toContainText(/Turn|Head|Walk|Leave|arrived|m\b/, { timeout: 30_000 })
})

test('press and hold on a leg’s map adds a place of your own there, once', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await open(page, '/leg/1')
  const canvas = page.locator('canvas.maplibregl-canvas').first()
  await expect(canvas).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1500)
  // A real press and hold, through Android's own input: the web view also reports it as a right-click.
  await canvas.scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  const box = (await canvas.boundingBox())!
  const dpr = await page.evaluate(() => devicePixelRatio)
  const web = await webViewOrigin(app.device)
  const [x, y] = [Math.round(web.x + (box.x + box.width / 2) * dpr), Math.round(web.y + (box.y + box.height / 2) * dpr)]
  await app.device.shell(`input swipe ${x} ${y} ${x} ${y} 1200`)
  const sheet = page.getByRole('dialog', { name: 'Add a place' })
  await expect(sheet).toBeVisible({ timeout: 10_000 })
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await sheet.getByLabel('Name').fill('Chai stall by the gate')
  await sheet.getByRole('radio', { name: 'Food' }).focus()
  await page.keyboard.press('Space')
  await sheet.getByRole('button', { name: 'Save the place' }).click()
  const toasts = page.getByRole('region', { name: /Notifications/ })
  await expect(toasts.getByRole('listitem').filter({ hasText: 'Saved Chai stall by the gate to your places.' })).toBeVisible({ timeout: 15_000 })
  // Tidy up: the place goes, so the next run starts without it.
  const api = await request.newContext({ baseURL: apiFromComputer(), ignoreHTTPSErrors: true })
  const login = await api.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const headers = { Authorization: `Bearer ${((await login.json()) as { accessToken: string }).accessToken}` }
  const mine = (await (await api.get('/v1/me/places', { headers })).json()) as { placeId: string; name: string }[]
  const added = mine.filter((p) => p.name === 'Chai stall by the gate')
  expect(added).toHaveLength(1)
  for (const p of added) expect((await api.delete(`/v1/me/places/${p.placeId}`, { headers })).status()).toBe(204)
  await api.dispose()
})

test('Rico: chat, and the back button closes it', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' }).click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  await expect(chat.getByRole('log', { name: 'Conversation with Rico' })).toContainText(/Good (morning|afternoon|evening)/)
  await chat.getByLabel('Message Rico').fill('move the bank to tomorrow')
  await chat.getByRole('button', { name: 'Send' }).click()
  await chat.getByRole('button', { name: 'Not now' }).click()
  await expect(chat.getByRole('log')).toContainText('Okay, I’ll leave it as it is.')
  await pressBack(app.device)
  await expect(chat).toBeHidden()
})

test("Rico's agent: three things from one message, on one card, and Undo takes them back", async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' }).click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  await chat.getByLabel('Message Rico').fill('Skip the university office, book a cab to the bank and go dark')
  await chat.getByRole('button', { name: 'Send' }).click()
  const card = chat.getByRole('group', { name: 'Rico’s card: 3 things' })
  await expect(card).toBeVisible({ timeout: 60_000 })
  for (const step of [/Skip “University office”/, /Book a .* to Bank/, /Switch to dark mode/]) await expect(card.getByRole('listitem').filter({ hasText: step })).toHaveCount(1)
  await card.getByRole('button', { name: 'Do all 3' }).click()
  await expect(card.getByRole('button', { name: 'Undo' })).toBeVisible({ timeout: 45_000 })
  await expect(chat.getByRole('log')).toContainText('All 3 done.')
  // Rico turned the app dark, and Android's status bar with it.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect((await statusBarPixel(app.device)).reduce((a, b) => a + b)).toBeLessThan(150)
  await card.getByRole('button', { name: 'Undo' }).click()
  await expect(card.getByText('Undone')).toBeVisible({ timeout: 45_000 })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', 'dark')
  await pressBack(app.device)
  await expect(chat).toBeHidden()
})

test('a simulated cab, paid from the wallet, with its OTP on Today', async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'Book a cab' }).first().click()
  const sheet = page.getByRole('dialog', { name: 'Book a ride' })
  const firstRide = sheet.getByRole('radio').first()
  await expect(firstRide).toBeVisible({ timeout: 20_000 })
  await firstRide.check()
  await sheet.getByRole('button', { name: /^Book .* \(demo\)$/ }).click()
  const ride = page.getByRole('dialog', { name: 'Your ride' })
  await expect(ride.getByText('OTP for the driver')).toBeVisible({ timeout: 30_000 })
  await pressBack(app.device)
  await expect(ride).toBeHidden()
  await expect(main.getByRole('button', { name: /OTP \d{4}/ })).toBeVisible()
})

test('the expense slip is saved on the phone, in Documents', async ({ app }) => {
  const page = app.page
  await open(page, '/summary')
  await page.getByRole('button', { name: 'Download the slip' }).click()
  const toasts = page.getByRole('region', { name: /Notifications/ })
  await expect(toasts.getByRole('listitem').filter({ hasText: /Slip saved to Documents\/Reroute\/reroute-expenses-[\d-]+\.txt/ })).toBeVisible({ timeout: 15_000 })
  expect((await app.device.shell('ls /sdcard/Documents/Reroute')).toString()).toMatch(/reroute-expenses-\d{4}-\d{2}-\d{2}\.txt/)
})


test("a leave-by alert reaches Android's notifications while Reroute is in the background", async ({ app }) => {
  const page = app.page
  await planFreshDay(app)
  await open(page, '/me')
  const notifications = page.getByRole('switch', { name: /Phone notifications/ })
  if ((await notifications.getAttribute('aria-checked')) !== 'true') await notifications.click()
  await expect(notifications).toHaveAttribute('aria-checked', 'true')
  await open(page, '/')
  // 9 minutes before the 08:50 departure.
  await setClock(page, '08:41')
  // Reroute goes to the background (without Playwright, which would keep the page "visible"), then the server's
  // 5-minute check sends "Leave in 9 min" over the live stream: Android shows it as a notification.
  await app.detach()
  await app.device.shell('input keyevent KEYCODE_HOME')
  // Paused, so its page is hidden (a moment after the launcher is on top), and soon: Android 15 and later cut a
  // background app's network a few seconds after it leaves the screen, and the alert comes over the network.
  await expect.poll(() => activityState(app.device), { timeout: 10_000 }).toMatch(/^(PAUSED|STOPPING|STOPPED)$/)
  await new Promise((r) => setTimeout(r, 500))
  const api = await request.newContext({ baseURL: apiFromComputer(), ignoreHTTPSErrors: true })
  const login = await api.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const headers = { Authorization: `Bearer ${((await login.json()) as { accessToken: string }).accessToken}` }
  const check = await api.post(`/v1/trips/${TRIP}/demo/check`, { headers, data: { idempotencyKey: `android-check-${Date.now()}` } })
  expect(check.ok()).toBe(true)
  await api.dispose()
  await expect
    .poll(async () => (await app.device.shell('dumpsys notification --noredact')).toString().includes('Leave in 9 min'), { timeout: 30_000 })
    .toBe(true)
  await app.device.shell(`am start -n ${PKG}/.MainActivity`)
  await expect.poll(() => foreground(app.device), { timeout: 10_000 }).toContain(PKG)
  await app.reattach()
})

/** Whether Android's freezer has stopped Reroute's own process (not its web view's sandboxed renderer). */
async function frozen(device: AndroidDevice): Promise<boolean> {
  const out = (await device.shell(`dumpsys activity processes ${PKG}`)).toString()
  const own = out.split('ProcessRecord{').find((block) => block.includes(PKG) && !block.includes('sandboxed'))
  return /isFrozen=true/.test(own ?? '')
}

// With Firebase set up (README, "Push notifications": google-services.json in the APK, the service account key on
// the stack's worker), the alert also comes as a push, which reaches Reroute after Android has frozen it. Run with
// PUSH_E2E=1.
test('a leave-by alert reaches a frozen Reroute as a push', async ({ app }) => {
  test.skip(!process.env.PUSH_E2E, 'Needs Firebase set up (README, "Push notifications"): PUSH_E2E=1')
  // Closed and opened again: Android takes down the last test's notification with it.
  await app.relaunch()
  const page = app.page
  await planFreshDay(app)
  await open(page, '/me')
  // Off and on again, so this run's registration is the one the server holds.
  const notifications = page.getByRole('switch', { name: /Phone notifications/ })
  if ((await notifications.getAttribute('aria-checked')) === 'true') await notifications.click()
  await expect(notifications).toHaveAttribute('aria-checked', 'false')
  const registered = page.waitForResponse((r) => r.url().endsWith('/v1/me/push-devices') && r.request().method() === 'POST', { timeout: 60_000 })
  await notifications.click()
  expect((await registered).ok()).toBe(true)
  // The server has this phone now: Me says the alerts reach it after Reroute is closed.
  await expect(page.getByText('the server sends them to this phone')).toBeVisible({ timeout: 15_000 })
  await open(page, '/')
  await setClock(page, '08:41')
  // Home, then two other apps: Android freezes Reroute and cuts its network, so only a push can reach it.
  await app.detach()
  await app.device.shell('input keyevent KEYCODE_HOME')
  await app.device.shell('am start -W -n com.android.settings/.Settings')
  await app.device.shell('am start -W -n com.google.android.deskclock/com.android.deskclock.DeskClock')
  await expect.poll(() => frozen(app.device), { timeout: 90_000, intervals: [2000] }).toBe(true)
  const api = await request.newContext({ baseURL: apiFromComputer(), ignoreHTTPSErrors: true })
  const login = await api.post('/v1/auth/demo', { data: { as: 'traveller' } })
  const headers = { Authorization: `Bearer ${((await login.json()) as { accessToken: string }).accessToken}` }
  const check = await api.post(`/v1/trips/${TRIP}/demo/check`, { headers, data: { idempotencyKey: `android-push-${Date.now()}` } })
  expect(check.ok()).toBe(true)
  await api.dispose()
  await expect
    .poll(async () => (await app.device.shell('dumpsys notification --noredact')).toString().includes('Leave in 9 min'), { timeout: 60_000 })
    .toBe(true)
  await app.device.shell(`am start -n ${PKG}/.MainActivity`)
  await expect.poll(() => foreground(app.device), { timeout: 10_000 }).toContain(PKG)
  await app.reattach()
})

// "Hey Rico" on the phone itself (Vosk): turned on in Me (Rico's ear downloads the first time, 38 MB), then
// recordings played into it in place of the microphone (debug builds only: DebugWakeReceiver). The recordings are
// Gemini's text-to-speech in three voices: three that should wake Rico and three that shouldn't. A server without
// Rico's voice (no Gemini key, like the CI stack) opens the chat instead of the voice screen. Run with WAKE_E2E=1.
test('“Hey Rico” wakes Rico, on screen, in the background or popping up over other apps, and nothing else does', async ({ app }) => {
  test.skip(!process.env.WAKE_E2E, 'Downloads Rico’s ear (38 MB): WAKE_E2E=1')
  test.setTimeout(300_000)
  const page = app.page
  await open(page, '/me')
  const hey = page.getByRole('switch', { name: /Hey Rico/ })
  if ((await hey.getAttribute('aria-checked')) !== 'true') await hey.click()
  await expect(hey).toHaveAttribute('aria-checked', 'true', { timeout: 240_000 })
  // Even when Reroute is closed: Android shows that Rico is listening, all the while.
  const closed = page.getByRole('switch', { name: /Even when Reroute is closed/ })
  await closed.click()
  await expect(closed).toHaveAttribute('aria-checked', 'true')
  const notices = async () => (await app.device.shell('dumpsys notification --noredact')).toString()
  await expect.poll(async () => (await notices()).includes('Rico is listening'), { timeout: 15_000 }).toBe(true)
  // The recordings go where the app can read them.
  const dir = `/sdcard/Android/data/${PKG}/files`
  const names = ['wake-hey-rico-kore', 'wake-hi-rico-puck', 'wake-okay-rico-charon', 'sleep-hey-ricky-kore', 'sleep-report-puck', 'sleep-hey-siri-charon']
  await app.device.shell(`mkdir -p ${dir}`)
  for (const name of names) await app.device.push(path.join(import.meta.dirname, 'wake', `${name}.wav`), `${dir}/${name}.wav`)
  const play = (name: string) => app.device.shell(`am broadcast -n ${PKG}/.DebugWakeReceiver --es wav ${dir}/${name}.wav`)
  const rico = page.getByRole('dialog', { name: 'Rico' })
  // Words that aren't "Hey Rico" leave him asleep.
  for (const name of names.filter((n) => n.startsWith('sleep-'))) {
    await play(name)
    await page.waitForTimeout(4000)
    await expect(rico).toHaveCount(0)
  }
  // On screen: Rico comes up.
  await play('wake-hey-rico-kore')
  await expect(rico).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')
  await expect(rico).toHaveCount(0)
  // In the background: Rico answers as a notification...
  await app.detach()
  await app.device.shell('input keyevent KEYCODE_HOME')
  await expect.poll(() => activityState(app.device), { timeout: 10_000 }).toMatch(/^(PAUSED|STOPPING|STOPPED)$/)
  await new Promise((r) => setTimeout(r, 5000))
  expect(await notices()).toContain('Rico is listening')
  await play('wake-okay-rico-charon')
  await expect.poll(async () => (await notices()).includes('Tap to talk'), { timeout: 30_000 }).toBe(true)
  // ...and a tap on it opens him.
  await app.device.shell(`am start -n ${PKG}/.MainActivity --es com.reroute.app.rico wake`)
  await expect.poll(() => foreground(app.device), { timeout: 10_000 }).toContain(PKG)
  await app.reattach()
  await expect(app.page.getByRole('dialog', { name: 'Rico' })).toBeVisible({ timeout: 20_000 })
  await app.page.keyboard.press('Escape')
  // With "Pop up over other apps" on (and Android's "Display over other apps" allowed), he pops up over whatever is
  // on screen and Reroute opens on him: no notification to tap.
  await app.device.shell(`appops set ${PKG} SYSTEM_ALERT_WINDOW allow`)
  await open(app.page, '/me')
  const popUp = app.page.getByRole('switch', { name: /Pop up over other apps/ })
  await popUp.click()
  await expect(popUp).toHaveAttribute('aria-checked', 'true')
  await app.detach()
  await app.device.shell('input keyevent KEYCODE_HOME')
  await expect.poll(() => activityState(app.device), { timeout: 10_000 }).toMatch(/^(PAUSED|STOPPING|STOPPED)$/)
  await new Promise((r) => setTimeout(r, 2000))
  const windows = async () => (await app.device.shell('dumpsys window windows')).toString()
  await play('wake-hi-rico-puck')
  await expect.poll(async () => (await windows()).includes('RicoPopUp'), { timeout: 15_000, intervals: [100] }).toBe(true)
  await expect.poll(() => foreground(app.device), { timeout: 15_000 }).toContain(PKG)
  await app.reattach()
  await expect(app.page.getByRole('dialog', { name: 'Rico' })).toBeVisible({ timeout: 20_000 })
  // Gone once Reroute is on screen.
  await expect.poll(async () => (await windows()).includes('RicoPopUp'), { timeout: 10_000 }).toBe(false)
  await app.page.keyboard.press('Escape')
  await app.device.shell(`appops set ${PKG} SYSTEM_ALERT_WINDOW default`)
  // Rico's ear runs in a process of its own: if it dies (the speech library can abort), Reroute carries on, and
  // opening Reroute again starts the ear again.
  const earPid = async () => (await app.device.shell(`pidof ${PKG}:ear`)).toString().trim()
  const ear = await earPid()
  expect(ear).toMatch(/^\d+$/)
  await app.device.shell(`run-as ${PKG} kill -9 ${ear}`)
  await expect.poll(earPid, { timeout: 10_000 }).not.toBe(ear)
  await expect.poll(async () => (await notices()).includes('Rico is listening'), { timeout: 10_000 }).toBe(false)
  await expect(app.page.getByRole('heading', { level: 1 })).toBeVisible()
  await app.detach()
  await app.device.shell('input keyevent KEYCODE_HOME')
  await expect.poll(() => activityState(app.device), { timeout: 10_000 }).toMatch(/^(PAUSED|STOPPING|STOPPED)$/)
  await app.device.shell(`am start -n ${PKG}/.MainActivity`)
  await expect.poll(() => foreground(app.device), { timeout: 10_000 }).toContain(PKG)
  await app.reattach()
  await expect.poll(async () => (await notices()).includes('Rico is listening'), { timeout: 20_000 }).toBe(true)
  expect(await earPid()).toMatch(/^\d+$/)
  // Off again, so the other journeys run as before.
  await open(app.page, '/me')
  const off = app.page.getByRole('switch', { name: /Hey Rico/ })
  if ((await off.getAttribute('aria-checked')) === 'true') await off.click()
  await expect(off).toHaveAttribute('aria-checked', 'false')
  await expect.poll(async () => (await notices()).includes('Rico is listening'), { timeout: 15_000 }).toBe(false)
})

test("talking to Rico goes to Android's speech recognizer", async ({ app }) => {
  const page = app.page
  await open(page, '/')
  await page.getByRole('button', { name: 'Rico, your travel companion. Chat with Rico' }).click()
  const chat = page.getByRole('dialog', { name: 'Rico' })
  await chat.getByRole('button', { name: 'Say your message' }).click()
  // Android's recognizer listens, then Rico says it heard nothing: the emulator hears silence, and Google's
  // recognizer there sometimes can't reach its servers instead (the web's message for that, too).
  const couldNot = /didn’t hear anything|didn’t catch that|can’t listen|couldn’t listen|Listening needs a connection/
  await expect(chat.getByRole('button', { name: 'Stop listening' }).or(chat.getByText(couldNot))).toBeVisible({ timeout: 15_000 })
  await expect(chat.getByText(couldNot).last()).toBeVisible({ timeout: 20_000 })
  await pressBack(app.device)
  await expect(chat).toBeHidden()
})

test('light and dark: the page and the status bar change together', async ({ app }) => {
  const page = app.page
  await open(page, '/me')
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

test('signs out, creates an email account, and Rico plans its first day by chatting', async ({ app }) => {
  const page = app.page
  await open(page, '/me')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/signin/, { timeout: 15_000 })
  await page.getByLabel('Your name').fill('Asha Rao')
  await page.getByLabel('Email').fill(`android.${Date.now()}@example.com`)
  await page.getByLabel('Password', { exact: true }).fill('rerouting-is-fun')
  await page.getByRole('button', { name: 'Create my account' }).click()
  // A new account meets Rico on Welcome (the same conversation as e2e/accounts.spec.ts).
  await expect(page).toHaveURL(/\/welcome$/, { timeout: 30_000 })
  const said = (text: string | RegExp) => expect(page.getByRole('log', { name: 'Conversation with Rico' }).getByText(text).last()).toBeVisible({ timeout: 30_000 })
  const answer = (label: string) => page.getByRole('group', { name: 'Answers' }).getByRole('button', { name: label }).click()
  const place = async (query: string, name: string) => {
    await page.getByLabel('Search for a place').fill(query)
    await page.getByRole('group', { name: 'Places found' }).getByRole('button', { name: new RegExp(name) }).first().click()
  }
  await said('Hi Asha! I’m Rico.')
  await said('Which city are you visiting?')
  await answer('Bengaluru')
  await said('When are you there?')
  await answer('From today')
  await said('And for how many days?')
  await answer('Just that day')
  await said(/Where are you staying\?/)
  await place('Majestic', 'Hotel near Majestic')
  await said(/first thing you need to do/)
  await page.getByLabel('Message Rico').fill('Bank')
  await page.getByRole('button', { name: 'Send' }).click()
  await said('Where is the bank?')
  await place('80 Feet Road', 'Bank, 80 Feet Road')
  await said('Does it happen at a fixed time?')
  await answer('Any time')
  await said('How long will the bank take?')
  await answer('30 min')
  await said('Added. Anything else today?')
  await answer('That’s all, plan my day')
  await said('Your day is planned!')
  await answer('Show my day')
  await expect(page.getByRole('heading', { level: 1, name: 'Bengaluru' })).toBeVisible({ timeout: 20_000 })
})

// On the new account's trip, which runs today: a link to the sample trip has already expired with its dates
// (14 and 15 October 2026), in the browser too.
test("a family share link points at the web app's host, not the app's own page", async ({ app }) => {
  const page = app.page
  await page.getByRole('button', { name: 'Share live trip' }).click()
  const sheet = page.getByRole('dialog', { name: /Share your trip/ })
  const sharing = sheet.getByRole('switch', { name: /Share live trip/ })
  await expect(sheet.getByText('Checking…')).toHaveCount(0, { timeout: 15_000 })
  await expect(sharing).toHaveAttribute('aria-checked', 'false')
  await sharing.click()
  const link = sheet.locator('#share-link')
  await expect(link).toHaveValue(/^https:\/\/[^/]+\/shared\/[\w-]+$/, { timeout: 15_000 })
  expect(new URL(await link.inputValue()).hostname).not.toBe('localhost')
  await sheet.getByRole('button', { name: 'Stop sharing' }).click()
  await pressBack(app.device)
  await expect(sheet).toBeHidden()
})

/** Console errors a browser shows as well, each where it belongs. Anything else fails. */
const EXPECTED: { journey: RegExp; text: RegExp; why: string }[] = [
  {
    journey: /^offline:/,
    text: /^Failed to load resource: net::ERR_(INTERNET_DISCONNECTED|CONNECTION_ABORTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE)( \(.*\))?$/,
    why: 'Chrome logs every request that fails while the phone has no signal; the app says it is offline and keeps the check-in',
  },
  {
    journey: /./,
    text: /^Failed to load resource: net::ERR_(CONNECTION_ABORTED|CONNECTION_RESET) \(\/v1\/trips\/[\w-]+\/live\)$/,
    why: 'the live stream is one long request, and a dropped connection ends it: the app reconnects and fetches the trip again',
  },
]

test('no errors in the app’s console on any of the journeys', async ({ app }) => {
  expect(app.errors.filter((e) => !EXPECTED.some((x) => x.journey.test(e.journey) && x.text.test(e.text)))).toEqual([])
})

/** Error lines in the app's own Logcat that don't come from Reroute. Anything else fails. */
const LOGCAT_EXPECTED: { line: RegExp; why: string }[] = [
  { line: /^E\/(GFXSTREAM|MESA)\s*:/, why: "the emulator's simulated GPU; a phone has neither" },
  { line: /^E\/chromium\s*: \[(?:[\d/.]+:)?ERROR:net\/socket\/ssl_client_socket_impl\.cc:\d+\] handshake failed;.* net_error -202$/, why: "the local stack's self-signed certificate, which debug builds accept on private addresses" },
  {
    line: /^E\/chromium\s*: \[(?:[\d/.]+:)?ERROR:(?!net\/)/,
    why: "WebView's own internal checks (its settings download, its page timing), not the page: the page's errors are in the console check",
  },
  {
    line: /^E\/cr_AwSupervisedUserDel\s*: Unable to determine if restricted content blocking is required\. Exception: java\.util\.concurrent\.TimeoutException$/,
    why: 'WebView asking Google Play whether Family Link limits content, which can time out just after the phone starts',
  },
  { line: /^E\/SurfaceSyncGroup\s*: Failed to receive transaction ready in \d+ms\. Marking SurfaceSyncGroup\(.*MainActivity.*\) as ready$/, why: "Android drawing a window late on a busy emulator: the framework's timing, not the app's" },
]

/** The app's own Logcat lines (its Linux user): Android's services log about every app, and those aren't the app's. */
async function appLogcat(device: AndroidDevice, levels = '*:V'): Promise<string[]> {
  const uid = /uid:(\d+)/.exec((await device.shell(`pm list packages -U ${PKG}`)).toString())?.[1]
  expect(uid).toBeTruthy()
  const log = (await device.shell(`logcat -d -v brief --uid=${uid} ${levels}`)).toString()
  return log.split(/\r?\n/).map((line) => line.replace(/\(\s*\d+\)/, ''))
}

test('Logcat: no error or crash from the app’s own process', async ({ app }) => {
  const errors = (await appLogcat(app.device, '*:E')).filter((line) => /^[EF]\//.test(line))
  expect(errors.filter((line) => !LOGCAT_EXPECTED.some((x) => x.line.test(line)))).toEqual([])
})

test('Logcat: nothing from the bridge, whose calls carry the sign-in token', async ({ app }) => {
  // Capacitor logs every plugin call and answer in a debug build unless told not to (capacitor.config.ts),
  // the Keystore's refresh token and Google's one-time code among them.
  expect((await appLogcat(app.device)).filter((line) => /methodData|Capacitor\/(Console|Plugin)|To native \(Capacitor plugin\)/.test(line))).toEqual([])
})
