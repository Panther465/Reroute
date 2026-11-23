import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

// Looking after an account through real email: the stack's Mailpit catches what the worker sends
// (docker-compose.yml). Needs the full stack; skipped when E2E_BASE_URL is unset.
test.skip(!process.env.E2E_BASE_URL, 'Set E2E_BASE_URL to run against a running stack')

const MAILPIT = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025'

type MailpitList = { messages: { ID: string; To: { Address: string }[]; Subject: string }[] }

/** The link in the newest email to `to` with this subject, as a path for this stack (`/reset-password#token=…`). */
async function linkFromEmail(page: Page, to: string, subject: string): Promise<string> {
  let link = ''
  await expect
    .poll(
      async () => {
        const list = (await (await page.request.get(`${MAILPIT}/api/v1/messages?limit=50`)).json()) as MailpitList
        const message = list.messages.find((m) => m.Subject === subject && m.To.some((t) => t.Address === to))
        if (!message) return ''
        const { Text } = (await (await page.request.get(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as { Text: string }
        link = /https?:\/\/[^/\s]+(\/(?:verify-email|reset-password)#token=[A-Za-z0-9_-]+)/.exec(Text)?.[1] ?? ''
        return link
      },
      { timeout: 30_000, message: `an email "${subject}" to ${to}` },
    )
    .not.toBe('')
  return link
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/signin')
  await page.getByText('Sign in', { exact: true }).first().click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

test('an account confirms its email, resets a forgotten password by email, downloads its data and is deleted', async ({ page }, info) => {
  test.setTimeout(150_000)
  const email = `e2e-${info.project.name}-${Date.now()}@example.com`
  const first = 'a long first password'
  const second = 'a brand new password'

  // Create the account.
  await page.goto('/signin')
  await page.getByLabel('Your name').fill('Meera Iyer')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(first)
  await page.getByRole('button', { name: 'Create my account' }).click()
  await expect(page).not.toHaveURL(/signin/, { timeout: 20_000 })

  // Me asks to confirm the address; the link in the email does.
  await page.goto('/me')
  await expect(page.getByText(`Confirm your email: open the link we sent to ${email}.`)).toBeVisible()
  await page.goto(await linkFromEmail(page, email, 'Confirm your email for Reroute'))
  await expect(page.getByRole('heading', { level: 1, name: 'Email confirmed' })).toBeVisible()
  // The token leaves the address bar.
  expect(new URL(page.url()).hash).toBe('')
  await page.getByRole('link', { name: 'Go to Me' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Me' })).toBeVisible()
  await expect(page.getByText(/Confirm your email/)).toHaveCount(0)

  // A new name.
  await page.getByRole('button', { name: 'Change your name' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Meera I.')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Meera I.', { exact: true })).toBeVisible()

  // A copy of everything kept.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download your data' }).click()])
  expect(download.suggestedFilename()).toMatch(/^reroute-data-\d{4}-\d{2}-\d{2}\.json$/)
  const data = JSON.parse(await readFile((await download.path())!, 'utf-8'))
  expect(data.account.email).toBe(email)
  expect(JSON.stringify(data)).not.toContain(first)

  // Forgot the password: a link by email, and a new one.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/signin/)
  await page.getByText('Sign in', { exact: true }).first().click()
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Forgot your password?' }).click()
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText(`If an account uses ${email}, we’ve emailed it a link`)).toBeVisible()
  await page.goto(await linkFromEmail(page, email, 'Reset your Reroute password'))
  await page.getByLabel('New password').fill(second)
  await page.getByRole('button', { name: 'Set my new password' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Password changed' })).toBeVisible()

  await signIn(page, email, first)
  await expect(page.getByText('Email or password is wrong.')).toBeVisible()
  await signIn(page, email, second)
  await expect(page).not.toHaveURL(/signin/, { timeout: 20_000 })

  // Deleting the account takes it all.
  await page.goto('/me')
  await page.getByRole('button', { name: 'Delete my account' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete your account?' })
  await dialog.getByLabel('Your password').fill(second)
  await dialog.getByRole('button', { name: 'Delete my account' }).click()
  await expect(page).toHaveURL(/signin/, { timeout: 20_000 })
  await expect(page.getByText('Your account and everything kept with it are deleted.')).toBeVisible()
  await signIn(page, email, second)
  await expect(page.getByText('Email or password is wrong.')).toBeVisible()
})

test('changing a trip’s dates and where you stay', async ({ page }, info) => {
  test.setTimeout(90_000)
  const email = `e2e-trip-${info.project.name}-${Date.now()}@example.com`
  await page.goto('/signin')
  await page.getByLabel('Your name').fill('Kabir Shah')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('a long password')
  await page.getByRole('button', { name: 'Create my account' }).click()
  await expect(page).not.toHaveURL(/signin/, { timeout: 20_000 })

  // A new account has no trip yet: Plan starts one, on a fixed future day.
  await page.goto('/plan')
  const main = page.getByRole('main')
  await main.getByLabel('Where are you staying?', { exact: true }).fill('Majestic')
  await main.getByRole('list', { name: 'Places found' }).getByRole('button', { name: /Hotel near Majestic/ }).first().click()
  await main.getByRole('button', { name: 'Change dates' }).click()
  await main.getByLabel('First day').fill('2030-01-15')
  await main.getByRole('button', { name: 'Create the trip' }).click()

  await page.getByRole('button', { name: 'Change dates or stay' }).click()
  const sheet = page.getByRole('dialog', { name: 'Change the trip' })
  await expect(sheet.getByLabel('First day')).toHaveValue('2030-01-15')
  await sheet.getByLabel('Last day').fill('2030-01-17')
  await sheet.getByRole('button', { name: 'Save the trip' }).click()
  await expect(page.getByRole('region', { name: /Notifications/ }).getByText('Trip updated.')).toBeVisible()
  // The trip now runs three days.
  await expect(page.getByRole('main').locator('dd').filter({ hasText: / to / })).toBeVisible()
})
