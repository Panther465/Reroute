import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import { queryClient } from '@/api/queries'
import { AuthCard } from './AuthCard'

function card(passwordReset: boolean) {
  queryClient.setQueryData(['auth-options'], { demoLogin: false, google: false, passwordReset })
  const router = createMemoryRouter([{ path: '/signin', element: <AuthCard onSignedIn={vi.fn()} /> }], { initialEntries: ['/signin'] })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  queryClient.clear()
})

describe('the sign-in card', () => {
  it('links the terms and the privacy policy where an account is made', () => {
    card(false)
    expect(screen.getByRole('link', { name: 'Terms of use' }).getAttribute('href')).toBe('/terms')
    expect(screen.getByRole('link', { name: 'Privacy policy' }).getAttribute('href')).toBe('/privacy')
  })

  it('offers a reset only where the server sends email', () => {
    card(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Sign in' }))
    expect(screen.queryByRole('button', { name: 'Forgot your password?' })).toBeNull()
  })

  it('emails a reset link, saying the same whether or not the account exists', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined)
    card(true)
    fireEvent.click(screen.getByRole('radio', { name: 'Sign in' }))
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'asha@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Forgot your password?' }))
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeTruthy()
    // The email typed for signing in carries over.
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('asha@example.com')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Email me a link' })))
    expect(post).toHaveBeenCalledWith('/v1/auth/password/forgot', { email: 'asha@example.com' }, { noRefresh: true })
    expect(screen.getByRole('status').textContent).toContain('If an account uses asha@example.com, we’ve emailed it a link')
    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }))
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})
