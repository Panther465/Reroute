import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { describe, expect, it } from 'vitest'
import Moderator from './Moderator'

/** /moderator opened directly, as a bookmark or a reload does, with the app's view of the traveller so far. */
function open(moderator: boolean | null) {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Outlet context={{ moderator }} />,
        children: [
          { path: 'moderator', element: <Moderator /> },
          { path: 'me', element: <h1>Me</h1> },
        ],
      },
    ],
    { initialEntries: ['/moderator'] },
  )
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return router
}

describe('the moderation screen opened directly', () => {
  it('waits for the profile before deciding: a moderator isn’t sent to Me while it loads', () => {
    const router = open(null)
    expect(router.state.location.pathname).toBe('/moderator')
    expect(screen.getByRole('heading', { name: 'Moderation' })).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Loading the queue')
  })

  it('sends someone who isn’t a moderator to Me', () => {
    const router = open(false)
    expect(router.state.location.pathname).toBe('/me')
  })
})
