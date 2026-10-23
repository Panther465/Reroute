// Late for someone else's meeting: it isn't yours to move, so tell the people waiting, early, with the
// time you'll really get there. The message is plain text the traveller can change before sending.

import { hhmm, lowerFirst } from './format'
import type { DayView } from './timeline'

export interface LateFor {
  taskId: string
  title: string
  /** The fixed time, HH:MM. */
  at: string
  /** When the plan gets you there, HH:MM. */
  arrive: string
  /** Minutes after the fixed time. */
  minutes: number
}

const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5))

/** The next fixed task the day reaches after its time, while you're still on your way to it. */
export function lateFixed(view: DayView | null): LateFor | null {
  if (!view) return null
  for (const stop of view.stops) {
    const task = stop.task
    if (stop.kind !== 'task' || !task?.fixedStart || task.state === 'done' || task.state === 'skipped' || stop.status === 'done') continue
    const leg = view.legs.find((l) => l.taskId === stop.id)
    const arrive = leg ? leg.arriveMin : stop.time
    if (view.now >= arrive) continue // already there
    const minutes = arrive - toMin(task.fixedStart)
    if (minutes > 0) return { taskId: stop.id, title: stop.title, at: task.fixedStart, arrive: hhmm(arrive), minutes }
  }
  return null
}

/** "the meeting", but "college", "school" and "class" read better without "the". */
const the = (title: string) => (/^(college|school|class|work|office)$/i.test(title.trim()) ? lowerFirst(title) : `the ${lowerFirst(title)}`)

const minutesSaid = (m: number) => {
  const h = Math.floor(m / 60)
  const rest = m % 60
  const mins = `${rest} minute${rest === 1 ? '' : 's'}`
  if (!h) return mins
  return `${h} hour${h === 1 ? '' : 's'}${rest ? ` ${mins}` : ''}`
}

export function lateMessage(l: LateFor): string {
  return `Hi, I’m sorry, I’m running about ${minutesSaid(l.minutes)} late for ${the(l.title)} at ${l.at}. I’ll be there around ${l.arrive}.`
}

/** When you can't get there before it ends: say so, and leave the new time to them. */
export function missMessage(title: string, at: string | undefined): string {
  return `Hi, I’m sorry, I won’t be able to make it to ${the(title)}${at ? ` at ${at}` : ''} today. Could we find another time?`
}

export const whatsappLink = (text: string) => `https://wa.me/?text=${encodeURIComponent(text)}`
export const smsLink = (text: string) => `sms:?&body=${encodeURIComponent(text)}`

/** Through the phone's share sheet where there is one (WhatsApp, SMS, email…); otherwise copied. */
export async function shareText(text: string): Promise<'shared' | 'copied' | 'cancelled' | 'failed'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled'
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}
