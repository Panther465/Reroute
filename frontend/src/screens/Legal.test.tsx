import { fireEvent, render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import Privacy from './Privacy'
import Terms from './Terms'

/** A legal page opened signed out, as a link from Google Play or the sign-in page does: no shell, no session. */
function open(path: string) {
  const router = createMemoryRouter(
    [
      { path: '/privacy', Component: Privacy },
      { path: '/terms', Component: Terms },
      { path: '/', element: <h1>Home</h1> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

/** The contents' links, and that each one lands on a section whose heading says the same. */
function contents() {
  const nav = screen.getByRole('navigation', { name: 'On this page' })
  const links = within(nav).getAllByRole('link')
  for (const link of links) {
    const href = link.getAttribute('href') ?? ''
    expect(href).toMatch(/^#[a-z-]+$/)
    const section = document.getElementById(href.slice(1))
    expect(section, `${href} has no section`).not.toBeNull()
    expect(within(section!).getByRole('heading', { level: 2 }).textContent).toBe(link.textContent)
  }
  return links.map((l) => l.textContent)
}

/** Every link inside the text to a section of the same page (#id) lands somewhere. */
function inPageLinksLand() {
  const main = screen.getByRole('main')
  for (const link of within(main).getAllByRole('link')) {
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) expect(document.getElementById(href.slice(1)), `${href} goes nowhere`).not.toBeNull()
  }
}

describe('the privacy policy', () => {
  it('has one title, its effective date and the sections Google Play and the DPDP Act expect', () => {
    open('/privacy')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeTruthy()
    expect(document.title).toBe('Privacy policy, Reroute')
    const effective = screen.getByText(/^Effective/)
    expect(effective.textContent).toBe('Effective 23 November 2026')
    expect(effective.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-23')

    const sections = contents()
    for (const title of [
      'Who runs Reroute',
      'What we keep',
      'What we never collect',
      'Other services that see some of your data',
      'Emails from us',
      'Error reports',
      'Download or delete your data',
      'Children',
      'Changes to this policy',
      'Contact us',
    ])
      expect(sections).toContain(title)
    inPageLinksLand()
  })

  it('says where the data is, the email links’ lifetimes, and how to download and delete it', () => {
    open('/privacy')
    const text = screen.getByRole('main').textContent ?? ''
    expect(text).toContain('Microsoft Azure’s Central India region')
    expect(text).toContain('1 hour (password reset) or 3 days (verification)')
    expect(text).toContain('Me → Account → Download your data')
    expect(text).toContain('Me → Account → Delete my account')
    expect(text).toContain('within 30 days')
    expect(text).toContain('under 18')
    expect(screen.getByRole('link', { name: 'github.com/Panther465/Reroute' }).getAttribute('href')).toBe('https://github.com/Panther465/Reroute')
  })

  it('names Sentry and the email provider among the outside services', () => {
    open('/privacy')
    const services = screen.getByRole('table', { name: 'Other services that see some of your data' })
    expect(within(services).getByRole('rowheader', { name: 'Sentry (error reports)' })).toBeTruthy()
    expect(within(services).getByRole('rowheader', { name: 'Our email provider' })).toBeTruthy()
  })

  it('gives every table column and row headers, in a box that scrolls on its own', () => {
    open('/privacy')
    const tables = screen.getAllByRole('table')
    expect(tables.length).toBe(3)
    for (const table of tables) {
      const box = table.closest('[role="region"]')
      expect(box?.getAttribute('tabindex')).toBe('0')
      expect(box?.getAttribute('aria-label')).toBe(table.querySelector('caption')?.textContent)
      const head = table.querySelectorAll('thead th')
      expect(head.length).toBeGreaterThan(2)
      head.forEach((th) => expect(th.getAttribute('scope')).toBe('col'))
      table.querySelectorAll('tbody tr').forEach((tr) => {
        expect(tr.firstElementChild?.tagName).toBe('TH')
        expect(tr.firstElementChild?.getAttribute('scope')).toBe('row')
        expect(tr.children.length).toBe(head.length)
      })
    }
  })

  it('leads to the terms, the source and the home page', () => {
    const router = open('/privacy')
    const footer = screen.getByRole('navigation', { name: 'More about Reroute' })
    expect(within(footer).getByRole('link', { name: /Source code/ }).getAttribute('href')).toBe('https://github.com/Panther465/Reroute')
    expect(screen.getByRole('link', { name: 'Reroute, home' }).getAttribute('href')).toBe('/')
    fireEvent.click(within(footer).getByRole('link', { name: 'Terms of use' }))
    expect(router.state.location.pathname).toBe('/terms')
    const h1 = screen.getByRole('heading', { level: 1, name: 'Terms of use' })
    // Arriving by a link starts at the new page's title, for screen readers.
    expect(document.activeElement).toBe(h1)
  })
})

describe('the terms of use', () => {
  it('has one title, its effective date and the sections that matter', () => {
    open('/terms')
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of use' })).toBeTruthy()
    expect(document.title).toBe('Terms of use, Reroute')
    expect(screen.getByText(/^Effective/).textContent).toBe('Effective 23 November 2026')

    const sections = contents()
    for (const title of [
      'What Reroute is',
      'Bookings and the wallet are simulated',
      'Your account',
      'What you add',
      'No guarantees',
      'Ending your account',
      'Governing law',
      'Changes to these terms',
      'Contact us',
    ])
      expect(sections).toContain(title)
    inPageLinksLand()
    expect(screen.getByRole('main').textContent).toContain('Nothing real is booked or charged.')
    expect(screen.getByRole('main').textContent).toContain('laws of India')
  })

  it('links into the privacy policy’s section on deleting, and that section exists', () => {
    const router = open('/terms')
    const toDelete = screen.getAllByRole('link', { name: 'privacy policy' }).find((a) => a.getAttribute('href') === '/privacy#your-data')
    expect(toDelete).toBeTruthy()
    fireEvent.click(toDelete!)
    expect(router.state.location.pathname).toBe('/privacy')
    expect(router.state.location.hash).toBe('#your-data')
    expect(document.getElementById('your-data')).not.toBeNull()
  })
})
