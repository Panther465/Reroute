// The phone's own voice, for when the natural voice can't be fetched (offline, or the server has it off).
// It doesn't say when each word is spoken on every phone, so its timing is estimated from the words.

import type { AlertPrefs } from '@/lib/store'

export interface PhoneSpeech {
  /** True once the phone starts speaking; false if it never does. */
  started: Promise<boolean>
  done: Promise<void>
  /** Milliseconds since it started speaking. */
  elapsed: () => number
  cancel: () => void
  /** About how long it takes to say. */
  estimateMs: number
}

/** The longest a line may hold the next one back, whatever the phone does. */
const LIMIT_MS = 15_000

/** About 160 words a minute at normal speed. */
export function phoneEstimateMs(text: string, rate: AlertPrefs['voiceRate']): number {
  const words = text.split(/\s+/).filter(Boolean).length
  const factor = rate === 'slow' ? 0.85 : rate === 'fast' ? 1.15 : 1
  return Math.round(((words * 60_000) / 160 / factor) + 250)
}

export function phoneSay(text: string, prefs: Pick<AlertPrefs, 'voiceRate' | 'volume'>): PhoneSpeech | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  const u = new SpeechSynthesisUtterance(text)
  // Roo's lines are written in English, so an English (India) voice reads them, whatever the app language.
  u.lang = 'en-IN'
  const voices = window.speechSynthesis.getVoices()
  const voice = voices.find((v) => v.lang === 'en-IN') ?? voices.find((v) => v.lang.startsWith('en'))
  if (voice) u.voice = voice
  u.rate = prefs.voiceRate === 'slow' ? 0.85 : prefs.voiceRate === 'fast' ? 1.15 : 1
  u.volume = prefs.volume
  let t0 = 0
  let finish = () => {}
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const started = new Promise<boolean>((resolve) => {
    u.onstart = () => {
      t0 = performance.now()
      resolve(true)
    }
    // Some browsers never say "start": go on without the phone's voice.
    setTimeout(() => resolve(false), 1500)
  })
  const stop = setTimeout(() => finish(), LIMIT_MS)
  u.onend = u.onerror = () => {
    clearTimeout(stop)
    finish()
  }
  window.speechSynthesis.cancel()
  window.speechSynthesis.speak(u)
  return {
    started,
    done,
    elapsed: () => (t0 ? performance.now() - t0 : 0),
    cancel: () => {
      window.speechSynthesis.cancel()
      finish()
    },
    estimateMs: phoneEstimateMs(text, prefs.voiceRate),
  }
}
