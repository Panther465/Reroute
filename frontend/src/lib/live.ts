// Live updates: GET /v1/trips/:id/live as server-sent events, read with fetch so the request can carry
// the Authorization header (EventSource can't). Reconnects with jittered backoff and refetches the trip after
// a reconnect, since events sent while the stream was down are lost; the trip query also refetches on events.
import { useEffect } from 'react'
import { apiBase, getAccessToken, refreshSession } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import { getState, setState } from './store'

export interface LiveEvent {
  event: string
  data: Record<string, unknown>
}

/** Parse SSE text into events. Keeps any incomplete trailing block in `rest`. */
export function parseSse(buffer: string): { events: LiveEvent[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: LiveEvent[] = []
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!data.length) continue
    try {
      events.push({ event, data: JSON.parse(data.join('\n')) as Record<string, unknown> })
    } catch {
      /* not JSON: ignore */
    }
  }
  return { events, rest }
}

/**
 * Show a system notification without ever throwing: Android Chrome refuses `new Notification()`
 * (only the service worker may show one), and a throw here would end the live stream.
 */
export async function notify(title: string, options: NotificationOptions) {
  try {
    if ('serviceWorker' in navigator) {
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise<null>((r) => setTimeout(() => r(null), 3000))])
      if (reg) {
        await reg.showNotification(title, options)
        return
      }
    }
  } catch {
    /* fall through to the page notification */
  }
  try {
    new Notification(title, options)
  } catch {
    /* no notifications here: the in-app banner still shows */
  }
}

function handle(tripId: string, e: LiveEvent) {
  if (e.event === 'plan_updated' || e.event === 'options_ready' || e.event === 'checkin_recorded' || e.event === 'trip_ended') {
    void queryClient.invalidateQueries({ queryKey: keys.trip(tripId) })
    void queryClient.invalidateQueries({ queryKey: keys.summary(tripId) })
  }
  // The server has drawn (more of) a plan's legs along the roads.
  if (e.event === 'paths_ready' && typeof e.data.version === 'number') void queryClient.invalidateQueries({ queryKey: keys.paths(tripId, e.data.version) })
  if (e.event === 'plan_updated' && e.data.trigger === 'late' && e.data.notify && !getState().pendingDelay) {
    // An automatic shift from the 5-minute check: show the banner. Its Undo comes from the trip's log.
    const version = typeof e.data.version === 'number' ? e.data.version : null
    setState({ autoBanner: { text: String(e.data.explanation ?? 'Reroute moved your later stops.'), previousVersion: null, version } })
  }
  if (e.event === 'plan_updated' && e.data.trigger === 'morning' && e.data.notify) {
    // The scheduler planned today on its own, early in the morning (it plans a later trip day once it begins).
    const version = typeof e.data.version === 'number' ? e.data.version : 0
    void import('./alerts').then(({ raise }) => raise({ key: `morning-${tripId}-${version}`, title: 'Your day is planned. Open Today to see when to leave.', tone: 'nudge' }))
  }
  if (e.event === 'leave_now') {
    const label = String(e.data.label ?? 'your next leg')
    const inMin = Number(e.data.inMin ?? 0)
    const text = inMin > 0 ? `Leave in ${inMin} min. ${label}.` : `Leave now. ${label}.`
    const seq = typeof e.data.seq === 'number' ? e.data.seq : null
    setState({ leaveNow: { text, at: Date.now(), seq } })
    if (getState().leaveAlerts && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      void notify('Reroute', { body: text, tag: `leave-${String(e.data.seq)}` })
    }
  }
}

/** Exponential backoff, capped at 30 s, with jitter so phones don't all reconnect at once after an outage. */
export function backoff(attempt: number, random = Math.random) {
  const cap = Math.min(30_000, 1000 * 2 ** attempt)
  return Math.round(cap / 2 + random() * (cap / 2))
}

/** Reconnect after this long without a byte, pings included (the server pings every 15 s). */
export const IDLE_MS = 45_000

export function useLive(tripId: string | null, enabled: boolean) {
  useEffect(() => {
    if (!tripId || !enabled) return
    const ctrl = new AbortController()
    let attempt = 0
    let connected = false
    let minWait = 0

    async function connect(): Promise<void> {
      while (!ctrl.signal.aborted) {
        try {
          const res = await fetch(`${apiBase}/v1/trips/${tripId}/live`, {
            headers: { Accept: 'text/event-stream', ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}) },
            credentials: 'include',
            signal: ctrl.signal,
          })
          if (res.status === 401) {
            const refreshed = await refreshSession()
            // Refused: the session has ended and the app goes to Sign in; the stream starts again from there.
            if (refreshed === 'rejected') return
            if (refreshed === 'ok') continue
            throw new Error('live: refresh unreachable')
          }
          // 429: too many open streams for this traveller (other tabs). Back off like any error, at
          // least as long as the server asks, so the stream never spins.
          if (res.status === 429) minWait = Math.max(0, Number(res.headers.get('Retry-After') ?? 0)) * 1000
          if (!res.ok || !res.body) throw new Error(`live ${res.status}`)
          attempt = 0
          // Anything sent while the stream was down is lost: catch up from the trip itself.
          if (connected) void queryClient.invalidateQueries({ queryKey: keys.trip(tripId!) })
          connected = true
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
          // The server pings every 15 s. Silence for longer is a connection that died without closing (a
          // network handover): cancel it so the loop reconnects, or leave-now alerts would never arrive.
          let heard = Date.now()
          const watchdog = setInterval(() => {
            if (Date.now() - heard > IDLE_MS) void reader.cancel()
          }, IDLE_MS / 3)
          let buffer = ''
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              heard = Date.now()
              const parsed = parseSse(buffer + value)
              buffer = parsed.rest
              for (const e of parsed.events) {
                try {
                  handle(tripId!, e)
                } catch {
                  /* one bad event must not end the stream */
                }
              }
            }
          } finally {
            clearInterval(watchdog)
          }
        } catch {
          if (ctrl.signal.aborted) return
        }
        attempt++
        await new Promise((r) => setTimeout(r, Math.max(minWait, backoff(attempt))))
        minWait = 0
      }
    }
    void connect()
    return () => ctrl.abort()
  }, [tripId, enabled])
}
