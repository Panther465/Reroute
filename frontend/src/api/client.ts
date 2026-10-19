// The fetch wrapper for both APIs (one origin, behind NGINX).
// - The access token lives in memory only. On a 401 the client refreshes once (refresh cookie + CSRF header) and retries.
// - Errors arrive as { error: { code, message, traceId } } and become an ApiError.
// - Every POST carries an idempotencyKey. Callers pass a key per action, so retries of that action reuse it.

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''

export class ApiError extends Error {
  status: number
  code: string
  traceId: string
  constructor(status: number, code: string, message: string, traceId = '') {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.traceId = traceId
  }
  get offline() {
    return this.code === 'OFFLINE'
  }
}

let accessToken: string | null = null
/** The Simulate panel's "Go offline" switch: every call fails as if the network were down. */
let forcedOffline = false
export function setForcedOffline(value: boolean) {
  forcedOffline = value
}
export type RefreshResult = 'ok' | 'rejected' | 'unreachable'
let refreshing: Promise<RefreshResult> | null = null
/** How long a refresh may take before the app treats the server as out of reach (a weak signal, not a sign-out). */
const REFRESH_TIMEOUT_MS = 6000
const authListeners = new Set<(signedIn: boolean) => void>()

/**
 * Whether the server answered lately. A weak connection can leave the browser "online" while
 * nothing gets through; the app then behaves as offline until a request succeeds again.
 */
let reachable = true
const reachListeners = new Set<() => void>()
function setReachable(value: boolean) {
  if (reachable === value) return
  reachable = value
  reachListeners.forEach((l) => l())
}
export function isReachable() {
  return reachable
}
export function onReachableChange(listener: () => void) {
  reachListeners.add(listener)
  return () => {
    reachListeners.delete(listener)
  }
}

export function setAccessToken(token: string | null) {
  accessToken = token
  authListeners.forEach((l) => l(token !== null))
}

export function getAccessToken() {
  return accessToken
}

export function onAuthChange(listener: (signedIn: boolean) => void) {
  authListeners.add(listener)
  return () => {
    authListeners.delete(listener)
  }
}

export function newKey(prefix = 'rr') {
  return `${prefix}-${crypto.randomUUID()}`
}

export function cookie(name: string) {
  const hit = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : ''
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `HTTP_${res.status}`
  let message = 'Something went wrong. Try again.'
  let traceId = res.headers.get('x-request-id') ?? ''
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; traceId?: string }; detail?: unknown }
    if (body.error) {
      code = body.error.code ?? code
      message = body.error.message ?? message
      traceId = body.error.traceId ?? traceId
    }
  } catch {
    /* not JSON */
  }
  return new ApiError(res.status, code, message, traceId)
}

/**
 * Ask for a new access token with the refresh cookie. Concurrent callers share one attempt.
 * - 'ok': a new token is in place.
 * - 'rejected': the server refused the cookie; the session is over and the traveller signs in again.
 * - 'unreachable': no answer within 6 s, a rate limit or a server error. The session may still be fine.
 */
export function refreshSession(): Promise<RefreshResult> {
  if (refreshing) return refreshing
  const attempt = attemptRefresh()
  refreshing = attempt
  // Clear the shared slot only once this attempt has settled and is still the one stored, so an
  // attempt that finishes without awaiting can't leave a stale result behind for later callers.
  void attempt.finally(() => {
    if (refreshing === attempt) refreshing = null
  })
  return attempt
}

async function attemptRefresh(): Promise<RefreshResult> {
  if (forcedOffline) return 'unreachable'
  // No CSRF cookie on the same origin means there was never a session here (a first visit): skip a
  // request that could only be refused. (On another API origin the cookie isn't readable.)
  if (!BASE && !cookie('rr_csrf')) return 'rejected'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': cookie('rr_csrf'), 'X-Request-ID': crypto.randomUUID() },
      signal: ctrl.signal,
    })
    setReachable(true)
    // Only a refused cookie ends the session. A rate limit (429) or a server error is a passing problem.
    if (res.status === 401 || res.status === 403) {
      setAccessToken(null)
      return 'rejected'
    }
    if (!res.ok) return 'unreachable'
    const body = (await res.json()) as { accessToken: string }
    setAccessToken(body.accessToken)
    return 'ok'
  } catch {
    setReachable(false)
    return 'unreachable'
  } finally {
    clearTimeout(timer)
  }
}

/** True when an error means the session is gone and the traveller must sign in again. */
export function isSignedOutError(err: unknown) {
  return err instanceof ApiError && err.status === 401
}

/** For failed calls: nothing was saved, so nothing will sync later. */
export const OFFLINE_MESSAGE = "You're offline. Try again when you have signal."

export interface RequestOptions {
  body?: unknown
  /** Required for POST. Reuse the same key when retrying the same action. */
  idempotencyKey?: string
  signal?: AbortSignal
  query?: Record<string, string | number | undefined | null>
  /** Return the raw Response (for downloads and streams). */
  raw?: boolean
  /** Skip the refresh-and-retry dance (used by auth calls). */
  noRefresh?: boolean
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))

  let body: string | undefined
  if (method === 'POST') {
    const key = opts.idempotencyKey ?? newKey()
    body = JSON.stringify({ ...((opts.body as object | undefined) ?? {}), idempotencyKey: key })
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body)
  }

  const send = () => {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Request-ID': crypto.randomUUID() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    return fetch(url, { method, headers, body, credentials: 'include', signal: opts.signal })
  }

  const attempt = async () => {
    try {
      if (forcedOffline) throw new TypeError('offline')
      const res = await send()
      setReachable(true)
      return res
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      if (!forcedOffline) setReachable(false)
      throw new ApiError(0, 'OFFLINE', OFFLINE_MESSAGE)
    }
  }

  let res = await attempt()
  if (res.status === 401 && !opts.noRefresh) {
    const refreshed = await refreshSession()
    if (refreshed === 'ok') res = await attempt()
    // The token may still be good once the signal is back: report it as offline, not as signed out.
    else if (refreshed === 'unreachable') throw new ApiError(0, 'OFFLINE', OFFLINE_MESSAGE)
  }
  if (!res.ok) throw await parseError(res)
  if (opts.raw) return res as unknown as T
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body: unknown, opts?: RequestOptions) => request<T>('PATCH', path, { ...opts, body }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
}

export const apiBase = BASE
