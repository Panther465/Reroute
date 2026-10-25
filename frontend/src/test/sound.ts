// Sound for tests of Rico's voice: a steady voice-like tone, and how to hear its pitch again.

export const RATE = 24_000

/** A voice-like tone: a note and two overtones, for `seconds`. */
export function tone(hz: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(RATE * seconds))
  for (let i = 0; i < out.length; i++) {
    const t = (2 * Math.PI * hz * i) / RATE
    out[i] = 0.4 * Math.sin(t) + 0.2 * Math.sin(2 * t) + 0.1 * Math.sin(3 * t)
  }
  return out
}

/** The pitch of a steady stretch, from a third of the way in: the first lag at which it repeats itself almost
 *  exactly. */
export function pitchOf(s: Float32Array): number {
  const at = Math.floor(s.length / 3)
  const n = 4800
  const r = (lag: number) => {
    let dot = 0
    let a = 0
    let b = 0
    for (let i = 0; i < n; i++) {
      dot += s[at + i] * s[at + i + lag]
      a += s[at + i] ** 2
      b += s[at + i + lag] ** 2
    }
    return dot / Math.sqrt(a * b)
  }
  for (let lag = Math.floor(RATE / 600); lag < RATE / 70; lag++) {
    const here = r(lag)
    if (here > 0.9 && here >= r(lag - 1) && here >= r(lag + 1)) {
      // Between whole samples, by the parabola through the peak.
      const [l, h] = [r(lag - 1), r(lag + 1)]
      return RATE / (lag + (l - h) / (2 * (l - 2 * here + h)))
    }
  }
  return 0
}
