// What Roo feels and does, apart from how it's drawn (engine.ts draws it): each mood's face; the little acts
// that bring it to life (a giggle when it's poked, a startle, and fidgets of its own when nothing's happening:
// a look around, a wiggle, a dance, a stretch, a yawn, a wink); and the felt emotes that float off it (Zzz, a ?
// while it thinks, a ! when something's wrong, hearts, sparkles).

import type { Mood } from '@/components/roo/mood'
import { REST, type MouthParams } from '@/lib/roo/lipsync/mouth'

// ---------- faces ----------

/** A face, as targets the springs move towards. The stitched eyes are one shape at a time (a blink hides the
 *  change): open, happy ^ ^, asleep ‿ ‿, golden stars, red hearts, or a giggle's > <. */
export interface Face {
  eyesOpen: number
  happy: number
  sleep: number
  star: number
  heart: number
  squint: number
  /** The eye on your right closes to a ^, the other stays as it is. */
  wink: number
  wide: number
  brows: number
  browTilt: number
  /** /// stitched over the cheeks. */
  blush: number
  /** A worried drop of sweat on the brow. */
  sweat: number
  look: readonly [number, number] | null
  tilt: number
  leaf: number
  mouth: MouthParams
  /** The mouth pulled to one side, in body radii (a thinking "hmm"). */
  mouthShift: number
  cheeks: number
}

export const GRIN: MouthParams = { open: 0.55, wide: 0.45, round: 0, smile: 1 }
const BEAM: MouthParams = { open: 0.75, wide: 0.5, round: 0, smile: 1 }
const GIGGLE: MouthParams = { open: 0.45, wide: 0.3, round: 0, smile: 1 }
const OOH: MouthParams = { open: 0.3, wide: -0.35, round: 0.8, smile: 0 }
const YAWN: MouthParams = { open: 0.95, wide: -0.1, round: 0.75, smile: 0 }

const NEUTRAL: Face = {
  eyesOpen: 1,
  happy: 0,
  sleep: 0,
  star: 0,
  heart: 0,
  squint: 0,
  wink: 0,
  wide: 1,
  brows: 0,
  browTilt: 0,
  blush: 0,
  sweat: 0,
  look: null,
  tilt: 0,
  leaf: 0,
  mouth: REST,
  mouthShift: 0,
  cheeks: 0.75,
}

export const FACES: Record<Mood, Face> = {
  idle: NEUTRAL,
  happy: { ...NEUTRAL, eyesOpen: 0, happy: 1, leaf: 0.06, mouth: GRIN, cheeks: 1 },
  wave: { ...NEUTRAL, eyesOpen: 0, happy: 1, tilt: 0.05, leaf: 0.08, mouth: GRIN, cheeks: 1 },
  // Starry-eyed and blushing.
  celebrate: { ...NEUTRAL, eyesOpen: 0, star: 1, blush: 1, leaf: 0.12, mouth: BEAM, cheeks: 1 },
  // Brows down, looking up and away, its mouth pulled to the side: "hmm".
  thinking: { ...NEUTRAL, brows: 1, browTilt: -0.25, look: [-0.7, 0.75], tilt: -0.08, leaf: -0.22, mouth: { open: 0, wide: -0.25, round: 0, smile: 0.1 }, mouthShift: -0.05, cheeks: 0.65 },
  listening: { ...NEUTRAL, wide: 1.12, look: [0, 0], tilt: 0.1, leaf: 0.14, mouth: { open: 0.05, wide: 0, round: 0, smile: 0.5 }, cheeks: 0.8 },
  talking: { ...NEUTRAL, leaf: 0.04, cheeks: 0.8 },
  // Wide-eyed, brows up, an "oh!" mouth and a drop of sweat.
  alert: { ...NEUTRAL, wide: 1.14, brows: 1, browTilt: 0.3, look: [0, 0], leaf: 0.18, mouth: { open: 0.35, wide: -0.4, round: 1, smile: 0 }, sweat: 1, cheeks: 0.7 },
  sleeping: { ...NEUTRAL, eyesOpen: 0, sleep: 1, tilt: 0.06, leaf: -0.1, mouth: { open: 0, wide: -0.3, round: 0, smile: 0.2 }, cheeks: 0.65 },
}

// ---------- acts ----------

/** This frame's movement on top of the springs: each act adds to it. */
export interface Motion {
  /** Roll, clockwise (radians). */
  roll: number
  /** Up off the ground (body radii). */
  bob: number
  /** Taller and thinner above 1, squashed below. */
  stretch: number
  /** Nearer to you above 1. */
  zoom: number
  /** A nod down and a turn to your right (radians). */
  nod: number
  turn: number
  /** The sprout's extra sway (radians). */
  leaf: number
  /** How far to raise each arm (radians), when the act moves them. */
  armL: number | null
  armR: number | null
  /** Where to look, when the act looks somewhere. */
  look: readonly [number, number] | null
}

export function still(): Motion {
  return { roll: 0, bob: 0, stretch: 1, zoom: 1, nod: 0, turn: 0, leaf: 0, armL: null, armR: null, look: null }
}

export type Act = 'boop' | 'startle' | 'look' | 'bounce' | 'wiggle' | 'dance' | 'stretch' | 'yawn' | 'wink' | 'peek' | 'shake'

/** How long each act lasts (ms), and whether it starts with a hop. */
export const ACTS: Record<Act, { ms: number; hop?: boolean }> = {
  // Poked: > <, a blush and a giggling wobble.
  boop: { ms: 1150, hop: true },
  // Something's wrong: up on its toes, arms up, eyes wide.
  startle: { ms: 750, hop: true },
  look: { ms: 2400 },
  bounce: { ms: 700, hop: true },
  wiggle: { ms: 1400 },
  dance: { ms: 2800 },
  stretch: { ms: 1900 },
  yawn: { ms: 2700 },
  wink: { ms: 850 },
  // Leans in for a closer look at you.
  peek: { ms: 1500 },
  // Shakes its fur out.
  shake: { ms: 950 },
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
/** Up from 0 at an act's start and back to 0 at its end, so it leaves Roo as it found it. */
export const envelope = (k: number, rise = 0.12, fall = 0.18) => smooth(0, rise, k) * (1 - smooth(1 - fall, 1, k))
const TAU = 2 * Math.PI

/** Act `kind`, `k` of the way through (0..1), `t` seconds in: what it does to this frame's face and motion. */
export function perform(kind: Act, k: number, t: number, face: Face, m: Motion) {
  const e = envelope(k)
  switch (kind) {
    case 'boop':
      Object.assign(face, { eyesOpen: 0, happy: 0, sleep: 0, star: 0, heart: 0, squint: 1, blush: 1, cheeks: 1, mouth: GIGGLE })
      m.roll += 0.075 * Math.sin(TAU * 5.5 * t) * Math.exp(-2.2 * t) * e
      m.leaf += 0.3 * Math.sin(TAU * 4 * t) * Math.exp(-3 * t)
      // Squished by the poke, then up.
      m.stretch *= 1 - 0.14 * (1 - smooth(0, 0.12, k))
      break
    case 'startle':
      Object.assign(face, { eyesOpen: 1, happy: 0, sleep: 0, star: 0, squint: 0, wide: 1.3 })
      m.stretch *= 1 + 0.12 * (1 - smooth(0.15, 0.6, k))
      m.armL = m.armR = 1.0 * e
      break
    case 'look':
      m.look = k < 0.36 ? [-0.8, 0.12] : k < 0.72 ? [0.8, 0.05] : [0, 0]
      break
    case 'bounce':
      m.leaf += 0.22 * Math.sin(TAU * 3 * t) * Math.exp(-3 * t)
      break
    case 'wiggle':
      m.leaf += 0.3 * Math.sin(TAU * 4.5 * t) * Math.exp(-2 * t)
      m.roll += 0.03 * Math.sin(TAU * 2.2 * t) * e
      break
    case 'dance': {
      const beat = Math.sin(TAU * 1.5 * t)
      Object.assign(face, { eyesOpen: 0, happy: 1, mouth: GRIN, cheeks: 1 })
      m.roll += 0.085 * beat * e
      m.bob += 0.035 * Math.abs(beat) * e
      m.armL = 0.45 * e + 0.4 * beat * e
      m.armR = 0.45 * e - 0.4 * beat * e
      m.leaf += 0.14 * Math.sin(TAU * 3 * t) * e
      break
    }
    case 'stretch':
      // A crouch to get going, then up on its toes, arms high, eyes squeezed shut.
      m.stretch *= 1 - 0.12 * smooth(0, 0.14, k) * (1 - smooth(0.14, 0.24, k)) + 0.1 * smooth(0.18, 0.3, k) * (1 - smooth(0.62, 0.82, k))
      if (k > 0.16 && k < 0.74) {
        m.armL = m.armR = 1.75
        Object.assign(face, { eyesOpen: 0, happy: 1, mouth: OOH })
      }
      break
    case 'yawn':
      if (k > 0.12 && k < 0.78) {
        m.stretch *= 1 + 0.06 * envelope((k - 0.12) / 0.66)
        m.armL = m.armR = 1.25
        Object.assign(face, { eyesOpen: 0, happy: 1, mouth: YAWN })
        face.tilt += 0.06
        m.leaf -= 0.12
      } else if (k >= 0.78) face.eyesOpen *= 0.55
      break
    case 'wink':
      face.wink = k > 0.08 && k < 0.8 ? 1 : 0
      face.cheeks = 1
      face.mouth = GRIN
      break
    case 'peek':
      m.zoom *= 1 + 0.045 * e
      m.nod += 0.1 * e
      face.wide = Math.max(face.wide, 1.12)
      break
    case 'shake':
      m.roll += 0.075 * Math.sin(TAU * 7 * t) * (1 - k) * e
      m.turn += 0.12 * Math.cos(TAU * 7 * t) * (1 - k) * e
      m.leaf += 0.35 * Math.sin(TAU * 7 * t + 1) * (1 - k)
      if (k > 0.6) Object.assign(face, { eyesOpen: 0, happy: 1 })
      break
  }
}

/** Something Roo does by itself when nothing's happening, for its mood (`r` is a random number 0..1): none in
 *  moods with something on their mind. After a long while with nothing happening, it may yawn. */
export function fidget(mood: Mood, quietMs: number, r: number): Act | null {
  const pick = (acts: Act[]) => acts[Math.min(acts.length - 1, Math.floor(r * acts.length))]
  if (mood === 'idle') return quietMs > 40_000 && r < 0.3 ? 'yawn' : pick(['look', 'look', 'peek', 'wiggle', 'stretch', 'shake', 'bounce', 'wink'])
  if (mood === 'happy') return pick(['dance', 'dance', 'wiggle', 'bounce', 'wink', 'look', 'shake'])
  return null
}

// ---------- emotes ----------

/** A felt emote floating off Roo (its key is the rendered piece's). */
export interface Emote {
  key: string
  born: number
  /** When it's gone: it fades over its last 300 ms. */
  until: number
  /** Where it starts and how far it drifts over its life (body radii, from Roo's middle: x right, z up). */
  x: number
  z: number
  dx: number
  dz: number
  size: number
  /** Floats up and fades, pops up and bobs where it is, or twinkles. */
  how: 'float' | 'pop' | 'twinkle'
  spin: number
}

/** Where an emote is at `now`, how big and how solid; null once it's gone. */
export function emoteNow(e: Emote, now: number): { x: number; z: number; size: number; alpha: number; angle: number } | null {
  if (now >= e.until || now < e.born) return null
  const age = (now - e.born) / 1000
  const life = (e.until - e.born) / 1000
  const k = age / life
  const fade = 1 - smooth(life - 0.3, life, age)
  const ease = 1 - (1 - k) ** 2
  switch (e.how) {
    case 'float':
      return {
        x: e.x + e.dx * ease + 0.04 * Math.sin(TAU * 1.3 * age),
        z: e.z + e.dz * ease,
        size: e.size * (0.55 + 0.45 * smooth(0, 0.4, k)),
        alpha: smooth(0, 0.12, age) * fade,
        angle: e.spin * 0.25 * Math.sin(TAU * 0.8 * age),
      }
    case 'pop': {
      // Overshoots as it pops up, then bobs; a ! shivers as it lands.
      const pop = age < 0.15 ? 1.25 * smooth(0, 0.15, age) : 1.25 - 0.25 * smooth(0.15, 0.32, age)
      return {
        x: e.x,
        z: e.z + 0.025 * Math.sin(TAU * 0.9 * age),
        size: e.size * pop,
        alpha: smooth(0, 0.08, age) * fade,
        angle: e.spin * (0.1 * Math.sin(TAU * 0.7 * age) + 0.25 * Math.sin(TAU * 8 * age) * Math.exp(-6 * age)),
      }
    }
    case 'twinkle':
      return { x: e.x + e.dx * k, z: e.z + e.dz * k, size: e.size * Math.sin(Math.PI * k), alpha: 1, angle: e.spin * k * 1.2 }
  }
}
