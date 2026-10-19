import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, refreshSession, setAccessToken, setForcedOffline } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { User } from '@/api/types'
import { getSessionStatus, resetSession, restoreSession } from './session'

const user = { userId: 'u1', name: 'Asha Rao', email: 'asha@example.com', role: 'traveller', isDemo: true } as unknown as User

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((url: string | URL, init: RequestInit = {}) => impl(String(url), init)))
}

beforeEach(() => {
  setForcedOffline(false)
  setAccessToken(null)
  queryClient.clear()
  resetSession()
  // A browser that has signed in here before carries the readable CSRF cookie.
  document.cookie = 'rr_csrf=test-csrf; path=/'
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('refreshSession', () => {
  it('tries again after going back online (a quick answer never sticks)', async () => {
    setForcedOffline(true)
    expect(await refreshSession()).toBe('unreachable')
    setForcedOffline(false)
    stubFetch(async () => json(200, { accessToken: 'tok' }))
    expect(await refreshSession()).toBe('ok')
  })

  it("skips the request on a first visit, with no session cookie, and answers 'rejected'", async () => {
    document.cookie = 'rr_csrf=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT'
    const fetchSpy = vi.fn()
    stubFetch(fetchSpy)
    expect(await refreshSession()).toBe('rejected')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("answers 'ok' and keeps the new token", async () => {
    stubFetch(async () => json(200, { accessToken: 'tok' }))
    expect(await refreshSession()).toBe('ok')
  })

  it("answers 'rejected' when the server refuses the cookie", async () => {
    stubFetch(async () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } }))
    expect(await refreshSession()).toBe('rejected')
  })

  it("answers 'unreachable' with no network, a rate limit or a server error, never 'rejected'", async () => {
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')))
    expect(await refreshSession()).toBe('unreachable')
    stubFetch(async () => json(502, {}))
    expect(await refreshSession()).toBe('unreachable')
    stubFetch(async () => json(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests. Wait a minute and try again.' } }))
    expect(await refreshSession()).toBe('unreachable')
  })

  it("gives up after 6 seconds on a weak connection and answers 'unreachable'", async () => {
    vi.useFakeTimers()
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const result = refreshSession()
    await vi.advanceTimersByTimeAsync(6000)
    expect(await result).toBe('unreachable')
  })
})

describe('restoring the session', () => {
  it('stays signed in, offline, when the server is out of reach and this phone has the session', async () => {
    queryClient.setQueryData(keys.me, user)
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')))
    await restoreSession()
    expect(getSessionStatus()).toBe('signedIn')
  })

  it('signs out when the cookie is refused, even with a saved session', async () => {
    queryClient.setQueryData(keys.me, user)
    stubFetch(async () => json(401, {}))
    await restoreSession()
    expect(getSessionStatus()).toBe('signedOut')
  })

  it('signs out when out of reach with nothing saved', async () => {
    stubFetch(async () => Promise.reject(new TypeError('Failed to fetch')))
    await restoreSession()
    expect(getSessionStatus()).toBe('signedOut')
  })

  it('moves to signed out when a later refresh is refused (the session ran out)', async () => {
    stubFetch(async () => json(200, { accessToken: 'tok' }))
    await restoreSession()
    expect(getSessionStatus()).toBe('signedIn')
    const responses = [json(401, {}), json(401, {})]
    stubFetch(async () => responses.shift()!)
    await expect(api.get('/v1/me')).rejects.toMatchObject({ status: 401 })
    expect(getSessionStatus()).toBe('signedOut')
  })

  it('keeps the session when a refresh after a 401 is out of reach, and reports it as offline', async () => {
    stubFetch(async () => json(200, { accessToken: 'tok' }))
    await restoreSession()
    let n = 0
    stubFetch(async () => (n++ === 0 ? json(401, {}) : Promise.reject(new TypeError('Failed to fetch'))))
    await expect(api.get('/v1/me')).rejects.toMatchObject({ code: 'OFFLINE' })
    expect(getSessionStatus()).toBe('signedIn')
  })
})
