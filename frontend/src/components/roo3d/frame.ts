// Where Roo stands in its box. The live 3D Roo (engine.ts) and its stills (RooStill.tsx) are both placed by
// place() below, so a still lines up exactly with the live Roo that takes over from it.

import { RIG } from './rig'

export type Framing = 'full' | 'portrait'
export type Vec3 = readonly [number, number, number]

/** The part of the scene each framing shows in Roo's box: its height and the height of its middle, in body
 *  radii. */
export const FRAMES: Record<Framing, { height: number; middle: number }> = {
  full: { height: 2.93, middle: 0.24 },
  portrait: { height: 2.59, middle: 0.36 },
}
/** The live Roo's canvas reaches this far above its box (a share of its height), so a hop never cuts off the
 *  sprout, and this far out to each side (a share of its width), so a raised arm isn't cut off either. */
export const HEADROOM = 0.3
export const ELBOWROOM = 0.15

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A point (Blender's axes: x right, y away from you, z up; in body radii) to the master render's pixels. */
export function project(p: Vec3): [number, number] {
  const { right, up, centre } = RIG.camera
  return [centre[0] + dot(p, right) * RIG.ppu, centre[1] - dot(p, up) * RIG.ppu]
}

/** Where the master render's square goes in a box `w` by `h` (any unit): its left, top and side. The framing's
 *  middle is at the middle of the box, and its height fills the box's height. */
export function place(w: number, h: number, framing: Framing): { left: number; top: number; side: number } {
  const frame = FRAMES[framing]
  const scale = h / (frame.height * RIG.ppu)
  const [mx, my] = project([0, 0, frame.middle])
  return { left: w / 2 - mx * scale, top: h / 2 - my * scale, side: RIG.size * scale }
}

/** A still shows the master render's square and this much more all round (a share of its side), for the arms
 *  raised to wave or cheer and the tip of the sprout. */
export const STILL_MARGIN = 0.05

/** Where a still goes in a box `w` by `h`: the master render's square, and its margin. */
export function stillPlace(w: number, h: number, framing: Framing): { left: number; top: number; side: number } {
  const { left, top, side } = place(w, h, framing)
  const margin = side * STILL_MARGIN
  return { left: left - margin, top: top - margin, side: side + 2 * margin }
}
