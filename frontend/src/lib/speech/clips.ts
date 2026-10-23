// Roo's natural voice: a line read aloud by the server (GET /v1/speech/timed), with when each word is said.
// The last 24 clips stay ready, so a repeated line plays at once; older ones are let go.

import { api } from '@/api/client'
import type { SpeechTimed } from '@/api/types'
import type { TimedWord } from '@/lib/roo/lipsync/timeline'
import type { AlertPrefs } from '@/lib/store'
import { loudness } from './envelope'

export interface Prepared {
  url: string
  words: TimedWord[]
  durationMs: number
  /** How loud the voice is, filled in a moment after the clip arrives. */
  env: Float32Array | null
}

const KEEP = 24
const cache = new Map<string, Promise<Prepared>>()

function toBlob(base64: string, mime: string): Blob {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export function prepare(text: string, prefs: Pick<AlertPrefs, 'voiceId' | 'voiceRate'>): Promise<Prepared> {
  const key = `${prefs.voiceId}|${prefs.voiceRate}|${text}`
  const known = cache.get(key)
  if (known) {
    cache.delete(key)
    cache.set(key, known)
    return known
  }
  const made = (async () => {
    const res = await api.get<SpeechTimed>('/v1/speech/timed', { query: { text, voice: prefs.voiceId, rate: prefs.voiceRate }, timeoutMs: 12_000 })
    const blob = toBlob(res.audio, res.mime)
    const clip: Prepared = { url: URL.createObjectURL(blob), words: res.words, durationMs: res.durationMs, env: null }
    void loudness(blob).then((env) => {
      clip.env = env
    })
    return clip
  })()
  cache.set(key, made)
  made.catch(() => cache.delete(key))
  while (cache.size > KEEP) {
    const [oldest, clip] = cache.entries().next().value as [string, Promise<Prepared>]
    cache.delete(oldest)
    void clip.then((c) => URL.revokeObjectURL(c.url)).catch(() => undefined)
  }
  return made
}
