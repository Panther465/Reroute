// The fetch wrapper for both APIs (one origin, behind NGINX).
// - The access token lives in memory only. On a 401 the client refreshes once (refresh cookie + CSRF header) and retries.
// - Errors arrive as { error: { code, message, traceId } } and become an ApiError.
// - Every POST carries an idempotencyKey. Callers pass a key per action, so retries of that action reuse it.
// - The Android app calls the API's host from its own origin, where no cookie arrives: it keeps its refresh
//   token itself (lib/platform.ts) and sends it in the body.
import { isNative, native } from '@/lib/platform'

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? ''

/** Cookies go with every call in a browser; the Android app has none to send. */
export const credentialsMode: RequestCredentials = isNative() ? 'omit' : 'include'
/** Tells the API that the Android app is signing in, so the refresh token comes back in the body. */
const APP_CLIENT = { 'X-Reroute-Client': 'android' }

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
/**
 * A refresh with no answer may still have gone through: the server then holds a new token this phone never got,
 * and takes the old one back for 30 seconds only, after which it ends the whole session as stolen
 * (backend/app/security.py). So it goes again every few seconds for 20 seconds after it was sent, then on a new
 * connection or when the app is back on screen.
 */
const REFRESH_RETRY_MS = 3000
const REFRESH_RETRY_FOR_MS = 20_000
/** When the refresh that got no answer was sent (null: none is owed). */
let owedSince: number | null = null
let retryTimer: ReturnType<typeof setTimeout> | undefined
const authListeners = new Set<(signedIn: boolean) => void>()

/**
 * Whether the server answered lately. A weak connection can leave the browser "online" while
 * nothing gets through; the app then behaves as offline until a request succeeds again, or until
 * the phone has a new connection.
 */
let reachable = true
const reachListeners = new Set<() => void>()
function setReachable(value: boolean) {
  if (reachable === value) return
  reachable = value
  reachListeners.forEach((l) => l())
}
// A new connection gets a fresh chance at once, and the next request that fails takes it away again. Without
// this, check-ins saved offline waited for some other request to get through first, up to a minute later. A
// refresh still owed goes again then, and when the app is back on screen.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    setReachable(true)
    refreshOwed()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshOwed()
  })
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

const answerListeners = new Set<() => void>()
/** Calls `listener` after each request the server answers with success, reachable or not before. */
export function onAnswered(listener: () => void) {
  answerListeners.add(listener)
  return () => {
    answerListeners.delete(listener)
  }
}

export function setAccessToken(token: string | null) {
  accessToken = token
  // A new token, or the session ending, settles a refresh still owed.
  owedSince = null
  clearTimeout(retryTimer)
  retryTimer = undefined
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
 * - 'rejected': the server refused the cookie, or this phone holds no session; the traveller signs in again.
 * - 'unreachable': no answer within 6 s, a rate limit or a server error. The session may still be fine, and the
 *   refresh goes again by itself (REFRESH_RETRY_MS).
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

/**
 * Whether this phone still holds a session to refresh: the token the Android app keeps, or in a browser the CSRF
 * cookie, which comes and goes with the refresh cookie (it can't be read when the API is on another origin).
 */
export async function holdsSession(): Promise<boolean> {
  return native.session ? !!(await native.session.load()) : !!cookie('rr_csrf')
}

/** No answer, or none that settles it (a 5xx, a rate limit): the refresh is owed, and goes again within seconds. */
function unanswered(sentAt: number): RefreshResult {
  owedSince ??= sentAt
  if (retryTimer === undefined && Date.now() + REFRESH_RETRY_MS <= owedSince + REFRESH_RETRY_FOR_MS) {
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void refreshSession()
    }, REFRESH_RETRY_MS)
  }
  return 'unreachable'
}

/** A refresh still owed, on a new connection or back on screen: it starts its own 20 seconds if unanswered too. */
function refreshOwed() {
  if (owedSince === null) return
  owedSince = null
  void refreshSession()
}

async function attemptRefresh(): Promise<RefreshResult> {
  if (forcedOffline) return 'unreachable'
  // The Android app's own refresh token; with none kept, it was never signed in on this phone (or no longer is).
  const kept = native.session ? await native.session.load() : null
  // No CSRF cookie on the same origin means there's no session here (a first visit, or it ran out): skip a
  // request that could only be refused. (On another API origin the cookie isn't readable.)
  if ((native.session && !kept) || (!native.session && !BASE && !cookie('rr_csrf'))) {
    setAccessToken(null)
    return 'rejected'
  }
  const sentAt = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REFRESH_TIMEOUT_MS)
  try {
    const res = await fetch(
      `${BASE}/v1/auth/refresh`,
      kept
        ? {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json', 'X-Request-ID': crypto.randomUUID(), ...APP_CLIENT },
            body: JSON.stringify({ refreshToken: kept }),
            signal: ctrl.signal,
          }
        : {
            method: 'POST',
            credentials: 'include',
            headers: { 'X-CSRF-Token': cookie('rr_csrf'), 'X-Request-ID': crypto.randomUUID() },
            signal: ctrl.signal,
          },
    )
    setReachable(true)
    // Only a refused cookie ends the session. A rate limit (429) or a server error is a passing problem.
    if (res.status === 401 || res.status === 403) {
      if (kept) await native.session?.clear()
      setAccessToken(null)
      return 'rejected'
    }
    if (!res.ok) return unanswered(sentAt)
    const body = (await res.json()) as { accessToken: string; refreshToken?: string | null }
    // The token was just rotated: keep the new one, or the next launch would present a used one.
    if (kept && body.refreshToken) await native.session?.save(body.refreshToken).catch(() => {})
    setAccessToken(body.accessToken)
    return 'ok'
  } catch {
    setReachable(false)
    return unanswered(sentAt)
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
  /** Give up after this long (default 20 s; streams and downloads, `raw`, never time out). */
  timeoutMs?: number
}

/** No answer in time: nothing is known to be saved, so it behaves like a dropped connection (a check-in queues). */
export const SLOW_MESSAGE = 'Reroute is taking too long to answer. Check your signal and try again.'

function withTimeout(signal: AbortSignal | undefined, ms: number | undefined) {
  if (!ms || typeof AbortSignal.timeout !== 'function') return signal
  const timer = AbortSignal.timeout(ms)
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timer]) : (signal ?? timer)
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
    if (native.session && path.startsWith('/v1/auth/')) Object.assign(headers, APP_CLIENT)
    return fetch(url, { method, headers, body, credentials: credentialsMode, signal: withTimeout(opts.signal, opts.raw ? undefined : (opts.timeoutMs ?? 20_000)) })
  }

  const attempt = async () => {
    try {
      if (forcedOffline) throw new TypeError('offline')
      const res = await send()
      setReachable(true)
      return res
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      if ((err as Error).name === 'TimeoutError') throw new ApiError(0, 'OFFLINE', SLOW_MESSAGE)
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
  answerListeners.forEach((l) => l())
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
