// The signed-in session. The access token lives in memory; the refresh cookie restores it on load.
import { useEffect, useSyncExternalStore } from 'react'
import { api, apiBase, cookie, isSignedOutError, onAuthChange, refreshSession, setAccessToken, setForcedOffline } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Token, User } from '@/api/types'
import { cancelPendingCheckins } from './actions'
import { clearQueue } from './offlineQueue'
import { clearShareTokens } from './shareTokens'
import { setState } from './store'

export type SessionStatus = 'loading' | 'signedIn' | 'signedOut'

let status: SessionStatus = 'loading'
const listeners = new Set<() => void>()

function set(next: SessionStatus) {
  if (status === next) return
  status = next
  listeners.forEach((l) => l())
}

export function getSessionStatus() {
  return status
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

// A new token signs in; losing it (a refused refresh, or signing out) signs out. The app shell then
// sends the traveller to Sign in, with the screen they were on, and the live stream restarts once
// they are back.
onAuthChange((signedIn) => {
  if (signedIn) set('signedIn')
  else if (status !== 'loading') set('signedOut')
})

/**
 * Restore the session from the refresh cookie. Only a refused cookie signs out: if the server
 * can't be reached (no signal, or a weak one) and this phone has the traveller's saved session,
 * the app opens in offline mode with the saved plan.
 */
export async function restoreSession() {
  const result = await refreshSession()
  if (result === 'ok') return set('signedIn')
  const cachedUser = queryClient.getQueryData<User>(keys.me)
  set(result === 'unreachable' && cachedUser ? 'signedIn' : 'signedOut')
}

let started = false

/** Restore the session once per page load. */
export function useRestoreSession() {
  useEffect(() => {
    if (started) return
    started = true
    void restoreSession()
  }, [])
}

function accept(token: Token) {
  // Someone else signing in on this phone must not see the last traveller's saved plan.
  const previous = queryClient.getQueryData<User>(keys.me)
  if (previous && previous.userId !== token.user.userId) queryClient.clear()
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
    await fetch(`${apiBase}/v1/auth/logout`, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': cookie('rr_csrf') } })
  } catch {
    /* offline: the local session still ends */
  }
  // Nothing of this traveller's stays on the phone: saved plan, waiting check-ins, share links, demo switches.
  cancelPendingCheckins()
  clearQueue()
  clearShareTokens()
  setForcedOffline(false)
  setState({ demo: { enabled: false, offline: false }, change: null, autoBanner: null, leaveNow: null, pendingDelay: null, optimisticDone: [], startedSeq: null })
  queryClient.clear()
  localStorage.removeItem('reroute:cache')
  setAccessToken(null)
  set('signedOut')
}

export { isSignedOutError }

/** For tests. */
export function resetSession(next: SessionStatus = 'loading') {
  status = next
  started = false
  listeners.forEach((l) => l())
}
