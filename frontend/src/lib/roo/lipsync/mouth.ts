// Roo's mouth as a few numbers, so the 3D Roo's felt mouth takes the shape of each sound it says.

/** How open (0 shut … 1 wide open), how wide (−1 narrow … 1 wide), how round (lips pushed out) and how
 *  much the corners smile (0 … 1). */
export interface MouthParams {
  open: number
  wide: number
  round: number
  smile: number
}

/** The mouth between words: shut, with Roo's usual small smile. */
export const REST: MouthParams = { open: 0, wide: 0, round: 0, smile: 0.35 }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export function mix(a: MouthParams, b: MouthParams, t: number): MouthParams {
  return { open: lerp(a.open, b.open, t), wide: lerp(a.wide, b.wide, t), round: lerp(a.round, b.round, t), smile: lerp(a.smile, b.smile, t) }
}

/** The mouth's size in the flat drawing's units (viewBox 0 0 80 88): half its width, its height, how far
 *  the middle sits below the corners. The 3D mouth uses the same numbers, scaled. */
export function mouthSize(p: MouthParams) {
  const halfWidth = 6.5 * (1 + 0.35 * p.wide - 0.45 * p.round)
  const height = 1.1 + 9.5 * Math.max(0, p.open) * (1 - 0.25 * p.round)
  const dip = 3.2 * p.smile
  return { halfWidth, height, dip }
}

/** The outline as `n` points, corners first, with x across and y down, centred where the corners meet. A
 *  quadratic curve for each lip: the top lip lifts a little, the bottom one drops most of the opening. */
export function mouthOutline(p: MouthParams, n = 32): [number, number][] {
  const { halfWidth: w, height: h, dip } = mouthSize(p)
  const half = Math.floor(n / 2)
  const top = dip - 0.45 * h
  const bottom = dip + 0.75 * h
  const pts: [number, number][] = []
  // Along the top lip, left to right; then along the bottom lip, right to left.
  for (let i = 0; i <= half; i++) {
    const t = i / half
    pts.push([-w + 2 * w * t, 2 * t * (1 - t) * (2 * top)])
  }
  for (let i = 1; i < n - half; i++) {
    const t = i / (n - half)
    pts.push([w - 2 * w * t, 2 * t * (1 - t) * (2 * bottom)])
  }
  return pts
}
