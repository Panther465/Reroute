// How loud the voice is, 100 times a second, worked out once per clip: Roo's mouth opens wider on the
// loud parts. Decoded offline, so it needs no tap to unlock audio and no live audio graph.

const FRAMES_PER_SECOND = 100

export async function loudness(blob: Blob): Promise<Float32Array | null> {
  const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext
  if (!Offline) return null
  try {
    const ctx = new Offline(1, 1, 24000)
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const data = buf.getChannelData(0)
    const frame = Math.max(1, Math.round(buf.sampleRate / FRAMES_PER_SECOND))
    const out = new Float32Array(Math.ceil(data.length / frame))
    for (let f = 0; f < out.length; f++) {
      let sum = 0
      const end = Math.min(data.length, (f + 1) * frame)
      for (let i = f * frame; i < end; i++) sum += data[i] * data[i]
      out[f] = Math.sqrt(sum / Math.max(1, end - f * frame))
    }
    // Loud is the 95th percentile, so one pop doesn't make everything else look quiet.
    const sorted = Array.from(out).sort((a, b) => a - b)
    const top = sorted[Math.floor(sorted.length * 0.95)] || 1
    for (let f = 0; f < out.length; f++) out[f] = Math.min(1, out[f] / top)
    return out
  } catch {
    return null
  }
}

/** How loud the voice is `ms` into the clip (0–1); a steady middle when not known. */
export function loudAt(env: Float32Array | null, ms: number): number {
  if (!env || !env.length) return 0.8
  const i = Math.max(0, Math.min(env.length - 1, Math.round((ms / 1000) * FRAMES_PER_SECOND)))
  return env[i]
}
