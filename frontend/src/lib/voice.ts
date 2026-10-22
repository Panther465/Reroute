// Talking to Roo: one spoken sentence, understood on the phone. The browser turns speech into text
// (Chrome sends the audio to Google's speech service to do it; the app sends nothing itself), and
// parseCommand reads the text with plain patterns: no AI, and nothing is planned from it directly.

export type VoiceCommand =
  | { kind: 'late'; minutes: number | null }
  | { kind: 'done' }
  | { kind: 'left' }
  | { kind: 'next' }
  | { kind: 'add' }
  | { kind: 'unknown'; heard: string }

const WORDS: Record<string, number> = {
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  'twenty five': 25,
  'twenty-five': 25,
  thirty: 30,
  forty: 40,
  'forty five': 45,
  'forty-five': 45,
  fifty: 50,
  sixty: 60,
  ninety: 90,
}

/** Minutes in a spoken delay: "20 minutes", "twenty minutes", "half an hour", "an hour and a half". */
function minutesIn(text: string): number | null {
  if (/\b(an?|one) hour and a half\b|\bhour and a half\b|\b1\.5 hours?\b/.test(text)) return 90
  if (/\bhalf an hour\b|\bhalf hour\b/.test(text)) return 30
  if (/\bquarter of an hour\b|\bquarter hour\b/.test(text)) return 15
  const hours = text.match(/\b(\d+|an?|one|two)\s*(hours?|hrs?)\b/)
  if (hours) return ({ a: 1, an: 1, one: 1, two: 2 }[hours[1]] ?? Number(hours[1])) * 60
  const digits = text.match(/\b(\d{1,3})\s*(minutes?|mins?|m)\b/) ?? text.match(/\blate by (\d{1,3})\b/) ?? text.match(/\b(\d{1,3})\s+late\b/)
  if (digits) return Number(digits[1])
  for (const [word, n] of Object.entries(WORDS).sort((a, b) => b[0].length - a[0].length)) {
    if (new RegExp(`\\b${word}\\s*(minutes?|mins?)\\b`).test(text)) return n
  }
  return null
}

/** What a sentence asks for. Delays win over everything else: "I'm done, but 10 minutes late" is a delay. */
export function parseCommand(spoken: string): VoiceCommand {
  const text = spoken.toLowerCase().replace(/[’']/g, "'").replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim()
  if (/\b(late|behind|delayed|running over|overrun|more time|stuck)\b/.test(text)) return { kind: 'late', minutes: minutesIn(text) }
  if (/\b(what's next|what is next|next stop|when (do|should) i (leave|go)|where (do|should) i go)\b/.test(text)) return { kind: 'next' }
  if (/\b(i've left|i have left|leaving now|on my way|heading out|i'm leaving|i am leaving)\b/.test(text)) return { kind: 'left' }
  if (/\b(done|finished|completed?|all set|wrapped up)\b/.test(text)) return { kind: 'done' }
  if (/\b(add|new task|remind me to|i (also )?need to)\b/.test(text)) return { kind: 'add' }
  return { kind: 'unknown', heard: spoken.trim() }
}

interface Recognition {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  abort: () => void
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export const voiceSupported = () => recognitionCtor() !== null

/** Why listening stopped without words, in the traveller's terms. */
export class VoiceError extends Error {}

/**
 * Listen for one sentence (Indian English) and return what was heard. Gives up after `ms`; `signal`
 * stops listening at once (the microphone goes off) and the promise never settles.
 */
export function listenOnce({ ms = 8000, signal }: { ms?: number; signal?: AbortSignal } = {}): Promise<string> {
  const Ctor = recognitionCtor()
  if (!Ctor) return Promise.reject(new VoiceError('This browser can’t listen. Try Chrome, or tap the buttons instead.'))
  return new Promise((resolve, reject) => {
    const rec = new Ctor()
    rec.lang = 'en-IN'
    rec.interimResults = false
    rec.maxAlternatives = 1
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      rec.abort()
      finish(() => reject(new VoiceError('I didn’t hear anything. Tap me and try again.')))
    }, ms)
    signal?.addEventListener(
      'abort',
      () => {
        rec.abort()
        finish(() => {})
      },
      { once: true },
    )
    rec.onresult = (e) => finish(() => resolve(e.results[0]?.[0]?.transcript ?? ''))
    rec.onerror = (e) =>
      finish(() =>
        reject(
          new VoiceError(
            e.error === 'not-allowed' || e.error === 'service-not-allowed'
              ? 'The microphone is off for Reroute. Allow it in your browser to talk to me.'
              : e.error === 'no-speech'
                ? 'I didn’t hear anything. Tap me and try again.'
                : e.error === 'network'
                  ? 'Listening needs a connection. Tap the buttons instead.'
                  : 'I couldn’t listen just now. Tap the buttons instead.',
          ),
        ),
      )
    rec.onend = () => finish(() => reject(new VoiceError('I didn’t catch that. Tap me and try again.')))
    rec.start()
  })
}
