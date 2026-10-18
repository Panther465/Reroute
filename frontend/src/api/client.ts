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
let refreshing: Promise<boolean> | null = null
const authListeners = new Set<(signedIn: boolean) => void>()

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

function cookie(name: string) {
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

/** Ask for a new access token with the refresh cookie. Concurrent callers share one attempt. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      if (forcedOffline) return false
      const res = await fetch(`${BASE}/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': cookie('rr_csrf'), 'X-Request-ID': crypto.randomUUID() },
      })
      if (!res.ok) {
        setAccessToken(null)
        return false
      }
      const body = (await res.json()) as { accessToken: string }
      setAccessToken(body.accessToken)
      return true
    } catch {
      return false
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

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

  let res: Response
  try {
    if (forcedOffline) throw new TypeError('offline')
    res = await send()
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new ApiError(0, 'OFFLINE', "You're offline. Your plan still works, and changes sync when you're back.")
  }
  if (res.status === 401 && !opts.noRefresh && (await refreshSession())) {
    res = await send()
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
