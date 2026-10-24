// Alerts as push notifications in the Android app. While alerts are on and someone is signed in, the phone's
// Firebase token is registered with the server, which then sends each leave-by alert and the morning plan to it
// as well: they arrive even when Android has cut the app's network or frozen it, which a browser tab can't get.
// Turning alerts off or signing out takes the phone off again. In a browser there's no push, and none of this runs.
//
// The app still shows its own notifications from the live stream: a server without Firebase, or a push that's
// late, never leaves the traveller without one. Both copies of an alert carry the same notification number and
// words, and whichever comes second is left out (Alerts.java shows both); a banner on screen, likewise (seenAlert).
import { ApiError, api } from '@/api/client'
import type { PushDevice } from '@/api/types'
import { native } from './platform'
import { getState, setState } from './store'

/** The token this phone last registered, kept across restarts so it can be taken off later even if that fails now. */
const REGISTERED_KEY = 'reroute:push-registered'

function registered(): string | null {
  try {
    return localStorage.getItem(REGISTERED_KEY)
  } catch {
    return null
  }
}

function remember(token: string | null) {
  try {
    if (token) localStorage.setItem(REGISTERED_KEY, token)
    else localStorage.removeItem(REGISTERED_KEY)
  } catch {
    /* no storage: a phone left registered is forgotten when its sign-in ends */
  }
}

/** The token the server confirmed during this run: registering it again changes nothing. */
let confirmed: string | null = null

function settled(token: string | null) {
  confirmed = token
  // Me says alerts reach the phone after the app is closed only once the server has this phone.
  if (getState().pushReady !== (token !== null)) setState({ pushReady: token !== null })
}

// One change at a time: alerts turned on and off quickly, or a sign-out during a registration, end up as asked.
let queue: Promise<void> = Promise.resolve()
/** The last change asked for, when it failed: tried again when the app comes back to the screen. */
let failed: (() => Promise<void>) | null = null
let asked = 0

function serially(task: () => Promise<void>): Promise<void> {
  const mine = ++asked
  // A newer change replaces whatever failed before it.
  failed = null
  const run = queue.then(task, task).catch((err: unknown) => {
    if (mine === asked) failed = task
    throw err
  })
  queue = run.catch(() => {})
  return run
}

/** Tries the last change again if it failed (no signal, a server error). */
export function retryPush(): Promise<void> {
  const task = failed
  return task ? serially(task) : Promise.resolve()
}

/** The phone's id on the server: the SHA-256 of its token, which the server never shows. */
export async function deviceId(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Registers this phone while `on`, or takes it off. Does nothing where push isn't available. */
export function syncPush(on: boolean): Promise<void> {
  return serially(on ? register : () => unregister(false))
}

/**
 * Takes this phone off the server's list (alerts turned off, or signing out), and asks Firebase for a new token.
 * A phone registered on an earlier visit is covered too: the token is kept from before the server was asked.
 * Signing out never refreshes the session to ask: a refresh finishing after the sign-out could bring it back.
 */
export function dropPush(signingOut = false): Promise<void> {
  return serially(() => unregister(signingOut))
}

async function register() {
  if (!native.push) return
  // Throws when Firebase couldn't be reached (tried again later); null in a build without Firebase.
  const token = await native.push.token()
  if (!token) return settled(null)
  if (token === confirmed) return
  const before = registered()
  // Kept before asking, so a registration whose answer is lost can still be taken off.
  remember(token)
  // Firebase replaced the token since the last visit: the old one is of no use to the server any more.
  if (before && before !== token) await api.delete(`/v1/me/push-devices/${await deviceId(before)}`).catch(() => {})
  try {
    await api.post<PushDevice>('/v1/me/push-devices', { token, platform: 'android' })
  } catch (err) {
    // This server doesn't send pushes after all: nothing is registered, and nothing to try again.
    if (err instanceof ApiError && err.status === 409) {
      remember(null)
      return settled(null)
    }
    throw err
  }
  settled(token)
}

async function unregister(signingOut: boolean) {
  if (!native.push) return
  settled(null)
  const token = registered()
  if (!token) return
  let gone = false
  let failure: unknown = null
  try {
    await api.delete(`/v1/me/push-devices/${await deviceId(token)}`, { noRefresh: signingOut })
    gone = true
  } catch (err) {
    failure = err
  }
  // A new token in any case: Firebase stops delivering to the old one, so the server finds out it's gone.
  const forgot = await native.push.forget()
  // Done once the server took the phone off, or Firebase dropped the token. Neither (no signal, or no session to
  // ask with and no Firebase): the token stays kept and is tried again.
  if (gone || forgot) remember(null)
  else throw failure ?? new Error('The phone could not be taken off yet')
}

/**
 * Signed out while the server couldn't be told (no signal): this phone may still be registered to that traveller.
 * Firebase drops its token instead, so the server finds the phone gone at its next push. Run while signed out; it
 * does nothing while the phone still keeps a sign-in (the server was only out of reach when the app started).
 */
export function forgetPush(): Promise<void> {
  return serially(async () => {
    settled(null)
    if (!native.push || !registered()) return
    if (native.session && (await native.session.load())) return
    if (await native.push.forget()) remember(null)
    else throw new Error('Firebase could not be reached to drop the token')
  })
}

/**
 * How long two copies of one alert may be apart: the live stream's and the push's come within moments. Shorter
 * than the five minutes between the server's checks, so a new plan's alert in the same words still shows.
 */
const SAME_ALERT_MS = 4 * 60_000
const shown = new Map<string, number>()

/**
 * True when this alert (its trip, tag and words) was shown in the last few minutes; otherwise notes it as shown
 * now. The 10-minute and the at-time alert for a leg share a tag but not their words, so both show.
 */
export function seenAlert(tripId: string, tag: string, body: string, now = Date.now()): boolean {
  for (const [key, at] of shown) if (now - at > SAME_ALERT_MS) shown.delete(key)
  const key = `${tripId}\n${tag}\n${body}`
  if (shown.has(key)) return true
  shown.set(key, now)
  return false
}

/** A pushed alert that arrived while the app is on screen (or opened it): shown as the live stream's copy would be. */
export async function showPushed(alert: { kind: string; body: string; tag: string; tripId?: string; seq?: string; [detail: string]: string | undefined }) {
  if (alert.kind === 'nudge') {
    // Rico checking in: his bubble, once (the live stream may have brought it first).
    if (seenAlert(alert.tripId ?? '', alert.tag, `${alert.reason}|${alert.leaveBy}`)) return
    const { nudgeBubble } = await import('./roo/nudge')
    setState({ ricoBubble: nudgeBubble(alert) })
  } else if (alert.kind === 'leave_now') {
    // Already shown from the live stream: a banner the traveller dismissed stays dismissed.
    if (seenAlert(alert.tripId ?? '', alert.tag, alert.body)) return
    const seq = alert.seq != null && alert.seq !== '' ? Number(alert.seq) : null
    if (getState().leaveNow?.text !== alert.body) setState({ leaveNow: { text: alert.body, at: Date.now(), seq } })
  } else if (alert.kind === 'morning') {
    // raise() shows each alert once, by key: the live stream's copy uses the same one.
    const { raise } = await import('./alerts')
    raise({ key: alert.tag, title: alert.body, tone: 'nudge' })
  }
}
