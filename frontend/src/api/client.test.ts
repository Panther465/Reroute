import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, getAccessToken, newKey, setAccessToken, setForcedOffline } from './client'

type Call = { url: string; init: RequestInit }

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

let calls: Call[] = []
let responses: Array<(call: Call) => Response> = []

beforeEach(() => {
  calls = []
  responses = []
  setAccessToken(null)
  setForcedOffline(false)
  document.cookie = 'rr_csrf=csrf-123'
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const call = { url: String(url), init }
      calls.push(call)
      const next = responses.shift()
      if (!next) throw new Error(`unexpected fetch ${call.url}`)
      return next(call)
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

const header = (c: Call, name: string) => new Headers(c.init.headers).get(name)

describe('api client', () => {
  it('sends the access token and a request ID', async () => {
    setAccessToken('tok-1')
    responses.push(() => json(200, { ok: true }))
    await api.get('/v1/me')
    expect(header(calls[0], 'Authorization')).toBe('Bearer tok-1')
    expect(header(calls[0], 'X-Request-ID')).toMatch(/[0-9a-f-]{36}/)
  })

  it('refreshes once on a 401 with the CSRF header, then retries with the new token', async () => {
    setAccessToken('old')
    responses.push(() => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', traceId: 't1' } }))
    responses.push(() => json(200, { accessToken: 'new', expiresIn: 900 }))
    responses.push(() => json(200, { userId: 'u1' }))
    const me = await api.get<{ userId: string }>('/v1/me')
    expect(me.userId).toBe('u1')
    expect(calls.map((c) => c.url.replace(location.origin, ''))).toEqual(['/v1/me', '/v1/auth/refresh', '/v1/me'])
    expect(header(calls[1], 'X-CSRF-Token')).toBe('csrf-123')
    expect(calls[1].init.credentials).toBe('include')
    expect(header(calls[2], 'Authorization')).toBe('Bearer new')
    expect(getAccessToken()).toBe('new')
  })

  it('gives up after one failed refresh and signs out', async () => {
    setAccessToken('old')
    responses.push(() => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', traceId: 't1' } }))
    responses.push(() => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.', traceId: 't2' } }))
    await expect(api.get('/v1/me')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' })
    expect(calls).toHaveLength(2)
    expect(getAccessToken()).toBeNull()
  })

  it('parses the error shape into an ApiError', async () => {
    responses.push(() => json(409, { error: { code: 'OPTION_CLOSED', message: 'That option is no longer open.', traceId: 'abc' } }))
    const err = await api.post('/v1/trips/t/options/opt-1/accept', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'OPTION_CLOSED', message: 'That option is no longer open.', traceId: 'abc' })
  })

  it('adds an idempotency key to every POST and reuses it when the same action retries', async () => {
    const key = newKey('chk')
    responses.push(() => json(401, { error: { code: 'UNAUTHENTICATED', message: 'x', traceId: '' } }))
    responses.push(() => json(200, { accessToken: 'new' }))
    responses.push(() => json(200, { result: 'on_time' }))
    await api.post('/v1/trips/t/checkins', { taskId: 'task-meet', kind: 'done' }, { idempotencyKey: key })
    responses.push(() => json(200, { result: 'on_time' }))
    await api.post('/v1/trips/t/checkins', { taskId: 'task-meet', kind: 'done' }, { idempotencyKey: key })
    const bodies = calls.filter((c) => c.url.endsWith('/checkins')).map((c) => JSON.parse(String(c.init.body)))
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies.map((b) => b.idempotencyKey))).toEqual(new Set([key]))
    expect(bodies[0]).toMatchObject({ taskId: 'task-meet', kind: 'done' })
  })

  it('makes up a key for a POST that has none', async () => {
    responses.push(() => json(201, {}))
    await api.post('/v1/trips', { citySlug: 'bengaluru' })
    expect(JSON.parse(String(calls[0].init.body)).idempotencyKey).toMatch(/^rr-/)
  })

  it('reports a network failure as offline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    const err = await api.get('/v1/trips').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).offline).toBe(true)
  })

  it('fails as offline while the demo switch is on, without calling the network', async () => {
    setForcedOffline(true)
    const err = await api.get('/v1/trips').catch((e: unknown) => e)
    expect((err as ApiError).offline).toBe(true)
    expect(calls).toHaveLength(0)
  })
})
