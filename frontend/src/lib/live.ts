// Live updates: GET /v1/trips/:id/live as server-sent events, read with fetch so the request can carry
// the Authorization header (EventSource can't). Reconnects with backoff; the trip query refetches on events.
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

function handle(tripId: string, e: LiveEvent) {
  if (e.event === 'plan_updated' || e.event === 'options_ready' || e.event === 'checkin_recorded' || e.event === 'trip_ended') {
    void queryClient.invalidateQueries({ queryKey: keys.trip(tripId) })
    void queryClient.invalidateQueries({ queryKey: keys.summary(tripId) })
  }
  if (e.event === 'plan_updated' && e.data.trigger === 'late' && e.data.notify && !getState().pendingDelay) {
    // An automatic shift from the 5-minute check: show the banner. Its Undo comes from the trip's log.
    setState({ autoBanner: { text: String(e.data.explanation ?? 'Reroute moved your later stops.'), previousVersion: null } })
  }
  if (e.event === 'leave_now') {
    const label = String(e.data.label ?? 'your next leg')
    const inMin = Number(e.data.inMin ?? 0)
    const text = inMin > 0 ? `Leave in ${inMin} min. ${label}.` : `Leave now. ${label}.`
    setState({ leaveNow: { text, at: Date.now() } })
    if (getState().leaveAlerts && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification('Reroute', { body: text, tag: `leave-${String(e.data.seq)}` })
    }
  }
}

export function useLive(tripId: string | null, enabled: boolean) {
  useEffect(() => {
    if (!tripId || !enabled) return
    const ctrl = new AbortController()
    let attempt = 0

    async function connect(): Promise<void> {
      while (!ctrl.signal.aborted) {
        try {
          const res = await fetch(`${apiBase}/v1/trips/${tripId}/live`, {
            headers: { Accept: 'text/event-stream', ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}) },
            credentials: 'include',
            signal: ctrl.signal,
          })
          if (res.status === 401) {
            if (!(await refreshSession())) return
            continue
          }
          if (!res.ok || !res.body) throw new Error(`live ${res.status}`)
          attempt = 0
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            const parsed = parseSse(buffer + value)
            buffer = parsed.rest
            parsed.events.forEach((e) => handle(tripId!, e))
          }
        } catch {
          if (ctrl.signal.aborted) return
        }
        attempt++
        await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)))
      }
    }
    void connect()
    return () => ctrl.abort()
  }, [tripId, enabled])
}
