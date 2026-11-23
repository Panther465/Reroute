// Rico's part in alerts (lib/rico.tsx says why it comes through here): his check-in bubble, and his voice reading an
// alert aloud. Without him, no bubble, and the phone's own voice.
import { phoneSay } from './speech/phoneVoice'
import type { AlertPrefs, RicoBubble } from './store'

const nudge = Object.values(import.meta.glob<Record<string, unknown>>('./roo/nudge.ts', { eager: true }))[0]
const channel = Object.values(import.meta.glob<Record<string, unknown>>('./speech/channel.ts', { eager: true }))[0]

/** Rico checking in: his bubble for the live stream's or a push's nudge, or null without him. */
export function ricoBubble(data: Record<string, unknown>): RicoBubble | null {
  return (nudge?.nudgeBubble as ((data: Record<string, unknown>) => RicoBubble) | undefined)?.(data) ?? null
}

type Enqueue = (text: string, opts: { priority: 'alert'; interrupt: boolean; prefs: AlertPrefs }) => { done: Promise<void> }

/** An alert read aloud: in Rico's voice, cutting in on what he was saying; without him, the phone's own voice. */
export async function sayAlert(text: string, prefs: AlertPrefs) {
  const enqueue = channel?.enqueue as Enqueue | undefined
  if (enqueue) await enqueue(text, { priority: 'alert', interrupt: true, prefs }).done
  else await phoneSay(text, prefs)?.done
}
