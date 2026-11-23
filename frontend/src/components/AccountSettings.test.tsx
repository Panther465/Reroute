import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { User } from '@/api/types'
import * as store from '@/lib/store'
import { AccountSettings, VerifyEmailBanner } from './AccountSettings'

function user(overrides: Partial<User> = {}): User {
  return {
    userId: 'usr-1',
    email: 'asha@example.com',
    name: 'Asha Rao',
    role: 'traveller',
    isDemo: false,
    emailVerified: true,
    hasPassword: true,
    features: { bookings: true, aiHelper: false, voices: true, wallet: true, agent: false, voiceChat: false, push: false, email: true },
    ...overrides,
  }
}

function show(ui: React.ReactNode) {
  const router = createMemoryRouter(
    [
      { path: '/me', element: ui },
      { path: '/signin', element: <p>Sign in page</p> },
      { path: '/privacy', element: <p>Privacy page</p> },
    ],
    { initialEntries: ['/me'] },
  )
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
})

describe('Me → Account', () => {
  it('offers what each kind of account can do', () => {
    show(<AccountSettings user={user()} />)
    for (const name of ['Change your name', 'Change your password', 'Download your data', 'Delete my account']) expect(screen.getByRole('button', { name })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('/privacy')
    expect(screen.getByRole('link', { name: 'Terms of use' }).getAttribute('href')).toBe('/terms')
  })

  it('has no password to change for a Google account, and nothing to change or delete for the demo', () => {
    show(<AccountSettings user={user({ hasPassword: false })} />)
    expect(screen.queryByRole('button', { name: 'Change your password' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete my account' })).toBeTruthy()
  })

  it('keeps the demo account as it is', () => {
    show(<AccountSettings user={user({ isDemo: true })} />)
    for (const name of ['Change your name', 'Change your password', 'Delete my account']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(screen.getByRole('button', { name: 'Download your data' })).toBeTruthy()
  })

  it('changes the password with the current one, and says a wrong one beside its field', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError(403, 'WRONG_PASSWORD', 'Your current password is wrong.'))
    const toast = vi.spyOn(store, 'showToast')
    show(<AccountSettings user={user()} />)
    await click('Change your password')
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'old password' } })
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } })
    await click('Change my password')
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy()
    expect(post).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a brand new password' } })
    await click('Change my password')
    expect(screen.getByText('Your current password is wrong.')).toBeTruthy()

    post.mockResolvedValueOnce({ accessToken: 't2', tokenType: 'Bearer', expiresIn: 900, user: user(), refreshToken: null })
    await click('Change my password')
    expect(post).toHaveBeenLastCalledWith('/v1/me/password', { currentPassword: 'old password', newPassword: 'a brand new password' })
    expect(toast).toHaveBeenCalledWith({ title: 'Password changed. You’re signed out on your other devices.' })
  })

  it('deletes the account with its password, then goes to sign in', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    const router = show(<AccountSettings user={user()} />)
    await click('Delete my account')
    expect(screen.getByText(/Places you shared that everyone can find/)).toBeTruthy()
    // The sheet's button, not the one that opened it.
    const confirm = () => screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!
    await act(async () => fireEvent.click(confirm()))
    expect(screen.getByText('Enter your password.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'a long password' } })
    await act(async () => fireEvent.click(confirm()))
    expect(post).toHaveBeenCalledWith('/v1/me/delete', { password: 'a long password' })
    expect(router.state.location.pathname).toBe('/signin')
    expect(router.state.location.state).toEqual({ notice: 'Your account and everything kept with it are deleted.' })
  })

  it('asks a Google account to type its email instead', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValue(new ApiError(503, 'UNAVAILABLE', 'Couldn’t reach Raasta to remove your routes, so nothing was deleted.'))
    show(<AccountSettings user={user({ hasPassword: false })} />)
    await click('Delete my account')
    fireEvent.change(screen.getByLabelText('Type asha@example.com to confirm'), { target: { value: ' asha@example.com ' } })
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: 'Delete my account' }).at(-1)!))
    expect(post).toHaveBeenCalledWith('/v1/me/delete', { email: 'asha@example.com' })
    expect(screen.getByText('Couldn’t reach Raasta to remove your routes, so nothing was deleted.')).toBeTruthy()
  })

  it('downloads a copy of the data as the file the server names', async () => {
    const res = new Response('{"account":{}}', { headers: { 'content-disposition': 'attachment; filename="reroute-data-2026-11-23.json"' } })
    const get = vi.spyOn(api, 'get').mockResolvedValue(res)
    const created = vi.fn(() => 'blob:x')
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() })
    let saved = ''
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      saved = this.download
    })
    show(<AccountSettings user={user()} />)
    await click('Download your data')
    expect(get).toHaveBeenCalledWith('/v1/me/export', { raw: true })
    expect(saved).toBe('reroute-data-2026-11-23.json')
  })

  it('changes the name', async () => {
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(user({ name: 'Asha R.' }))
    show(<AccountSettings user={user()} />)
    await click('Change your name')
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Asha R. ' } })
    await click('Save')
    expect(patch).toHaveBeenCalledWith('/v1/me', { name: 'Asha R.' })
    expect(queryClient.getQueryData<User>(keys.me)?.name).toBe('Asha R.')
  })
})

describe('confirming the email', () => {
  it('shows until the address is confirmed, and sends the link again', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    show(<VerifyEmailBanner user={user({ emailVerified: false })} />)
    expect(screen.getByText('Confirm your email: open the link we sent to asha@example.com.')).toBeTruthy()
    await click('Send the link again')
    expect(post).toHaveBeenCalledWith('/v1/me/verification-email', {})
  })

  it('stays away once confirmed, or where the server sends no email', () => {
    show(<VerifyEmailBanner user={user({ emailVerified: false, features: { ...user().features, email: false } })} />)
    expect(screen.queryByText(/Confirm your email/)).toBeNull()
  })
})
