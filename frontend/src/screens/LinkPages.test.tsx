import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '@/api/client'
import { queryClient } from '@/api/queries'
import ResetPassword from './ResetPassword'
import VerifyEmail from './VerifyEmail'

/** Opens a page as the emailed link does: the token after the #. */
function open(path: string, Page: React.ComponentType, token?: string) {
  window.history.replaceState(null, '', token ? `${path}#token=${token}` : path)
  const router = createMemoryRouter([{ path, Component: Page }, { path: '/signin', element: <p>Sign in page</p> }], { initialEntries: [path] })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345'

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
  window.history.replaceState(null, '', '/')
})

describe('choosing a new password from the email', () => {
  it('sets it with the link’s token, which leaves the address bar', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    open('/reset-password', ResetPassword, TOKEN)
    expect(screen.getByRole('heading', { level: 1, name: 'Choose a new password' })).toBeTruthy()
    expect(window.location.hash).toBe('')
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Set my new password' })))
    expect(screen.getByText('Use at least 8 characters.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a brand new password' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Set my new password' })))
    expect(post).toHaveBeenCalledWith('/v1/auth/password/reset', { token: TOKEN, password: 'a brand new password' }, { noRefresh: true })
    expect(screen.getByRole('heading', { level: 1, name: 'Password changed' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/signin')
  })

  it('says when the link has expired', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(400, 'LINK_INVALID', 'This reset link has expired or was already used. Ask for a new one.'))
    open('/reset-password', ResetPassword, TOKEN)
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'a brand new password' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Set my new password' })))
    expect(screen.getByRole('alert').textContent).toContain('expired or was already used')
  })

  it('says a link without its token is incomplete', () => {
    open('/reset-password', ResetPassword)
    expect(screen.getByText(/This link is incomplete/)).toBeTruthy()
  })
})

describe('confirming an email from the link', () => {
  it('confirms it as the page opens, once', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    await act(async () => open('/verify-email', VerifyEmail, TOKEN))
    expect(await screen.findByRole('heading', { level: 1, name: 'Email confirmed' })).toBeTruthy()
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/v1/auth/email/verify', { token: TOKEN }, { noRefresh: true })
  })

  it('says when a link was already used', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(400, 'LINK_INVALID', 'This link has expired or was already used. Ask for a new one.'))
    await act(async () => open('/verify-email', VerifyEmail, 'zyxwvutsrqponmlkjihgfedcba543210'))
    expect((await screen.findByRole('alert')).textContent).toContain('You can send a new link from Me.')
  })
})
