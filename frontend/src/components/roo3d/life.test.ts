import { describe, expect, it } from 'vitest'
import type { Mood } from '@/components/roo/RooArt'
import { ACTS, emoteNow, FACES, fidget, perform, still, type Act, type Emote } from './life'
import { PIECES } from './rig'

const MOODS: Mood[] = ['idle', 'happy', 'wave', 'celebrate', 'thinking', 'listening', 'talking', 'alert', 'sleeping']

describe("Roo's life", () => {
  it('shows one pair of eyes in every mood', () => {
    for (const mood of MOODS) {
      const f = FACES[mood]
      const eyes = [f.eyesOpen, f.happy, f.sleep, f.star, f.heart, f.squint]
      expect(eyes.filter((v) => v > 0.5), mood).toHaveLength(1)
    }
  })

  it('has a rendered piece for every face and emote it shows', () => {
    for (const side of ['L', 'R']) {
      for (const kind of ['Eye Open', 'Eye Happy', 'Eye Sleep', 'Eye Star', 'Eye Heart', 'Eye Squint', 'Brow', 'Cheek', 'Blush']) expect(PIECES[`${kind}.${side}`], `${kind}.${side}`).toBeDefined()
    }
    for (const key of ['Sweat', 'Emote Heart', 'Emote Sparkle', 'Emote Z', 'Emote Question', 'Emote Exclaim']) expect(PIECES[key], key).toBeDefined()
  })

  it('leaves Roo as it found it when an act ends', () => {
    for (const kind of Object.keys(ACTS) as Act[]) {
      for (const k of [0, 1]) {
        const m = still()
        perform(kind, k, (k * ACTS[kind].ms) / 1000, { ...FACES.idle }, m)
        expect(Math.abs(m.roll), kind).toBeLessThan(0.01)
        expect(Math.abs(m.bob), kind).toBeLessThan(0.005)
        expect(Math.abs(m.nod) + Math.abs(m.turn), kind).toBeLessThan(0.01)
        expect(m.zoom, kind).toBeCloseTo(1, 2)
        // Arms an act raised are back down (or let go).
        for (const arm of [m.armL, m.armR]) if (arm !== null && kind !== 'stretch') expect(Math.abs(arm), kind).toBeLessThan(0.05)
      }
    }
  })

  it('fidgets only when it has nothing on its mind, and yawns only after a long quiet', () => {
    for (const mood of ['thinking', 'listening', 'talking', 'alert', 'sleeping', 'celebrate', 'wave'] as Mood[]) expect(fidget(mood, 60_000, 0.5), mood).toBeNull()
    for (let r = 0; r < 1; r += 0.05) {
      expect(fidget('idle', 5_000, r)).not.toBe('yawn')
      expect(fidget('happy', 60_000, r)).not.toBe('yawn')
      expect(ACTS[fidget('idle', 5_000, r)!]).toBeDefined()
      expect(ACTS[fidget('happy', 5_000, r)!]).toBeDefined()
    }
    expect(fidget('idle', 60_000, 0.1)).toBe('yawn')
  })

  it('floats emotes in, about and away, staying near Roo', () => {
    const kinds: Emote['how'][] = ['float', 'pop', 'twinkle']
    for (const how of kinds) {
      const e: Emote = { key: 'Emote Heart', born: 1000, until: 3000, x: 0.4, z: 1, dx: 0.3, dz: 0.6, size: 1, how, spin: 1 }
      expect(emoteNow(e, 999)).toBeNull()
      expect(emoteNow(e, 3000)).toBeNull()
      for (let now = 1000; now < 3000; now += 50) {
        const at = emoteNow(e, now)!
        expect(at.alpha).toBeGreaterThanOrEqual(0)
        expect(at.alpha).toBeLessThanOrEqual(1)
        expect(at.size).toBeLessThanOrEqual(1.25)
        expect(Math.abs(at.x)).toBeLessThan(1.6)
        expect(at.z).toBeLessThan(2.2)
      }
      // Faded out by the end.
      expect(emoteNow(e, 2999)!.alpha * (how === 'twinkle' ? emoteNow(e, 2999)!.size : 1)).toBeLessThan(0.05)
    }
  })
})
