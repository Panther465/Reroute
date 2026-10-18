// The signed-in session. The access token lives in memory; the refresh cookie restores it on load.
import { useEffect, useSyncExternalStore } from 'react'
import { api, ApiError, onAuthChange, refreshSession, setAccessToken } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Token, User } from '@/api/types'

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut'

let status: SessionStatus = 'loading'
const listeners = new Set<() => void>()

function set(next: SessionStatus) {
  status = next
  listeners.forEach((l) => l())
}

export function useSessionStatus() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => status,
  )
}

let started = false

/** Restore the session once per page load: refresh with the cookie, or fall back to the cached user offline. */
export function useRestoreSession() {
  useEffect(() => {
    if (started) return
    started = true
    void (async () => {
      const ok = await refreshSession()
      if (ok) return set('signedIn')
      // No network: keep the cached session so the saved plan still shows.
      const cachedUser = queryClient.getQueryData<User>(keys.me)
      set(cachedUser && !navigator.onLine ? 'signedIn' : 'signedOut')
    })()
    return onAuthChange((signedIn) => {
      if (signedIn) set('signedIn')
    })
  }, [])
}

function accept(token: Token) {
  setAccessToken(token.accessToken)
  queryClient.setQueryData(keys.me, token.user)
  set('signedIn')
}

export async function signInDemo(as: 'traveller' | 'moderator' = 'traveller') {
  accept(await api.post<Token>('/v1/auth/demo', { as }, { noRefresh: true }))
}

export async function signInWithGoogle(code: string) {
  accept(await api.post<Token>('/v1/auth/google', { code }, { noRefresh: true }))
}

export async function signOut() {
  try {
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('rr_csrf='))?.slice(8) ?? ''
    await fetch('/v1/auth/logout', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': decodeURIComponent(csrf) } })
  } catch {
    /* offline: the local session still ends */
  }
  setAccessToken(null)
  queryClient.clear()
  localStorage.removeItem('reroute:cache')
  set('signedOut')
}

/** True when an error means the session is gone and the traveller must sign in again. */
export function isSignedOutError(err: unknown) {
  return err instanceof ApiError && err.status === 401
}
