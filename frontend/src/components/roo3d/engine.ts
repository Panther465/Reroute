// Roo in 3D: the plush toy rendered in Blender (frontend/roo3d/: real fur, a stitched face, felt), drawn here as
// a stack of rendered pieces moved with springs. It breathes, blinks, hops each time it speaks, waves, and turns
// to look at your pointer (its face slides over its round body). Its felt mouth follows the voice: each frame
// it's cut to the shape lib/speech/channel.ts says Roo is making. It draws only while it's on screen.

import type { Mood } from '@/components/roo/RooArt'
import { mix, mouthOutline, mouthSize, REST, type MouthParams } from '@/lib/roo/lipsync/mouth'
import { mouthNow } from '@/lib/speech/channel'
import lg from './assets/roo-lg.webp'
import md from './assets/roo-md.webp'
import sm from './assets/roo-sm.webp'
import { PIECES, RIG, SHEETS } from './rig'

export type Framing = 'full' | 'portrait'

export interface EngineOptions {
  framing: Framing
  /** A small Roo (on Today): idle at 30 frames a second. */
  quiet?: boolean
  onReady: () => void
  onFail: () => void
}

export interface RooState {
  mood: Mood
  /** Bumped each time Roo says something: it hops. */
  hop: number
  theme: 'light' | 'dark'
}

// ---------- springs ----------

/** A damped spring towards a target: `freq` in Hz, `damping` 1 = no overshoot. */
class Spring {
  v = 0
  constructor(
    public x: number,
    private freq: number,
    private damping: number,
  ) {}
  to(target: number, dt: number): number {
    const w = 2 * Math.PI * this.freq
    let t = Math.min(dt, 1 / 20)
    while (t > 0) {
      const h = Math.min(t, 1 / 120)
      const a = w * w * (target - this.x) - 2 * this.damping * w * this.v
      this.v += a * h
      this.x += this.v * h
      t -= h
    }
    return this.x
  }
}

// ---------- look ----------

/** Each mood's face, as targets the springs move towards. */
interface Face {
  eyesOpen: number
  happy: number
  sleep: number
  wide: number
  brows: number
  browTilt: number
  look: [number, number] | null
  tilt: number
  leaf: number
  mouth: MouthParams
  cheeks: number
}

const FACES: Record<Mood, Face> = {
  idle: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0, mouth: REST, cheeks: 0.75 },
  happy: { eyesOpen: 0, happy: 1, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0.06, mouth: { open: 0.55, wide: 0.45, round: 0, smile: 1 }, cheeks: 1 },
  wave: { eyesOpen: 0, happy: 1, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0.05, leaf: 0.08, mouth: { open: 0.55, wide: 0.45, round: 0, smile: 1 }, cheeks: 1 },
  celebrate: { eyesOpen: 0, happy: 1, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0.12, mouth: { open: 0.75, wide: 0.5, round: 0, smile: 1 }, cheeks: 1 },
  thinking: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1, brows: 1, browTilt: -0.25, look: [-0.7, 0.75], tilt: -0.08, leaf: -0.22, mouth: { open: 0, wide: -0.15, round: 0, smile: 0 }, cheeks: 0.65 },
  listening: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1.12, brows: 0, browTilt: 0, look: [0, 0], tilt: 0.1, leaf: 0.14, mouth: { open: 0.05, wide: 0, round: 0, smile: 0.5 }, cheeks: 0.8 },
  talking: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0.04, mouth: REST, cheeks: 0.8 },
  alert: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1.14, brows: 1, browTilt: 0.3, look: [0, 0], tilt: 0, leaf: 0.18, mouth: { open: 0.35, wide: -0.4, round: 1, smile: 0 }, cheeks: 0.7 },
  sleeping: { eyesOpen: 0, happy: 0, sleep: 1, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0.06, leaf: -0.1, mouth: { open: 0, wide: -0.3, round: 0, smile: 0.2 }, cheeks: 0.65 },
}

// ---------- the rig ----------

type Vec3 = readonly [number, number, number]
type Pt = [number, number]

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A point (Blender's axes: x right, y away from you, z up; in body radii) to the master render's pixels. */
export function project(p: Vec3): Pt {
  const { right, up, centre } = RIG.camera
  return [centre[0] + dot(p, right) * RIG.ppu, centre[1] - dot(p, up) * RIG.ppu]
}

/** Turns a point about the body's centre: `yaw` towards your right, then `pitch` down. */
export function turn(p: Vec3, yaw: number, pitch: number): Vec3 {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const x = p[0] * cy - p[1] * sy
  const y = p[0] * sy + p[1] * cy
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  return [x, y * cp - p[2] * sp, y * sp + p[2] * cp]
}

/** The point on the body's front seen at (x, z) from straight ahead, `lift` out from the fabric. */
export function onBody(x: number, z: number, lift: number): Vec3 {
  const [a, b, c] = RIG.body.radii
  const y = -b * Math.sqrt(Math.max(1e-6, 1 - (x / a) ** 2 - (z / c) ** 2))
  const n: Vec3 = [x / (a * a), y / (b * b), z / (c * c)]
  const l = Math.hypot(...n)
  return [x + (n[0] / l) * lift, y + (n[1] / l) * lift, z + (n[2] / l) * lift]
}

const MOUTH_POINTS = 40
/** The felt sits on the pile, and is this thick. */
const FELT = 0.01

/** The felt mouth's outline in the master render's pixels, for a turn of the head. */
export function mouthPoints(p: MouthParams, yaw: number, pitch: number): Pt[] {
  const { mouthUnit, mouthZ, faceLift } = RIG.body
  return mouthOutline(p, MOUTH_POINTS).map(([x, y]) => project(turn(onBody(x * mouthUnit, mouthZ - y * mouthUnit, faceLift + FELT), yaw, pitch)))
}

/** The felt tongue: an oval low in the mouth (the mouth's outline cuts it). */
export function tonguePoints(p: MouthParams, yaw: number, pitch: number): Pt[] {
  const { mouthUnit, mouthZ, faceLift } = RIG.body
  const { halfWidth, height, dip } = mouthSize(p)
  const pts: Pt[] = []
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI
    const x = 0.55 * halfWidth * Math.cos(a)
    const y = dip + 0.66 * height + 0.36 * height * Math.sin(a)
    pts.push(project(turn(onBody(x * mouthUnit, mouthZ - y * mouthUnit, faceLift + FELT + 0.004), yaw, pitch)))
  }
  return pts
}

type SheetName = keyof typeof SHEETS
const URLS: Record<SheetName, string> = { lg, md, sm }

/** The smallest sheet sharp enough for `ppu` canvas pixels to the body's radius. */
export function pickSheet(ppu: number): SheetName {
  const names = (Object.keys(SHEETS) as SheetName[]).sort((a, b) => SHEETS[a].ppu - SHEETS[b].ppu)
  return names.find((n) => SHEETS[n].ppu >= ppu * 0.92) ?? names[names.length - 1]
}

/** The arm's rendered poses either side of `raise` (radians up from hanging), and how far towards the second. */
export function armPoses(side: 'L' | 'R', raise: number): { a: string; b: string; t: number } {
  const keys = Object.keys(PIECES)
    .filter((k) => k.startsWith(`arm.${side}.`))
    .sort((x, y) => PIECES[x].raise! - PIECES[y].raise!)
  let i = 0
  while (i < keys.length - 2 && raise > PIECES[keys[i + 1]].raise!) i++
  const lo = PIECES[keys[i]].raise!
  const hi = PIECES[keys[i + 1]].raise!
  return { a: keys[i], b: keys[i + 1], t: Math.max(0, Math.min(1, (raise - lo) / (hi - lo))) }
}

/** The part of the scene each framing shows in Roo's box: its height and the height of its middle, in body
 *  radii. */
const FRAMES: Record<Framing, { height: number; middle: number }> = {
  full: { height: 2.93, middle: 0.24 },
  portrait: { height: 2.59, middle: 0.36 },
}
/** The canvas reaches this far above Roo's box (a share of its height), so a hop never cuts off the sprout, and
 *  this far out to each side (a share of its width), so a raised arm isn't cut off either. */
const HEADROOM = 0.3
const ELBOWROOM = 0.15

// ---------- the engine ----------

export class RooEngine {
  private host: HTMLElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private sheet: SheetName | null = null
  private img: HTMLImageElement | null = null
  private loading: SheetName | null = null
  private raf = 0
  private last = 0
  private visible = true
  private frameSkip = false
  private readyCalled = false
  private disposed = false
  private state: RooState = { mood: 'happy', hop: 0, theme: 'light' }
  private hopAt = -1
  private hopBig = false
  private waveAt = -1
  private blinkAt = 0
  private nextBlink = 1500
  private pointer: { x: number; y: number; at: number } = { x: 0, y: 0, at: 0 }
  private glance: { x: number; y: number; until: number } = { x: 0, y: 0, until: 0 }
  private nextGlance = 5000
  private observers: (IntersectionObserver | ResizeObserver)[] = []
  private s = {
    hopY: new Spring(0, 5, 0.6),
    squash: new Spring(1, 5, 0.35),
    gazeX: new Spring(0, 7, 1),
    gazeY: new Spring(0, 7, 1),
    headX: new Spring(0, 2.2, 0.9),
    headY: new Spring(0, 2.2, 0.9),
    tilt: new Spring(0, 2.2, 0.9),
    eyesOpen: new Spring(1, 3.5, 0.85),
    happy: new Spring(0, 3.5, 0.85),
    sleep: new Spring(0, 3.5, 0.85),
    wide: new Spring(1, 3.5, 0.85),
    brows: new Spring(0, 3.5, 0.85),
    browTilt: new Spring(0, 3.5, 0.85),
    cheeks: new Spring(0.75, 3.5, 0.85),
    leaf: new Spring(0, 2.6, 0.22),
    armL: new Spring(0, 4, 0.55),
    armR: new Spring(0, 4, 0.55),
    open: new Spring(0, 14, 1),
    wideM: new Spring(0, 9, 1),
    round: new Spring(0, 9, 1),
    smile: new Spring(0.35, 9, 1),
  }
  /** This frame's pose, worked out by update() and drawn by draw(). */
  private pose = {
    hopY: 0,
    squash: 1,
    breath: 1,
    tilt: 0,
    yaw: 0,
    pitch: 0,
    gaze: [0, 0] as Pt,
    blink: 1,
    eyesOpen: 1,
    happy: 0,
    sleep: 0,
    wide: 1,
    brows: 0,
    browTilt: 0,
    cheeks: 0.75,
    leaf: 0,
    armL: 0,
    armR: 0,
    mouth: REST as MouthParams,
  }

  constructor(
    host: HTMLElement,
    private opts: EngineOptions,
  ) {
    this.host = host
    this.canvas = document.createElement('canvas')
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.style.cssText = `position:absolute;left:${-ELBOWROOM * 100}%;top:${-HEADROOM * 100}%;display:block;width:${(1 + 2 * ELBOWROOM) * 100}%;height:${(1 + HEADROOM) * 100}%;pointer-events:none`
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('No 2D canvas')
    this.ctx = ctx
    host.appendChild(this.canvas)
    this.resize()

    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting
      if (this.visible) this.start()
    })
    io.observe(host)
    const ro = new ResizeObserver(() => this.resize())
    ro.observe(host)
    this.observers.push(io, ro)
    window.addEventListener('pointermove', this.onPointer, { passive: true })
    window.addEventListener('pointerdown', this.onPointer, { passive: true })
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  set(next: Partial<RooState>) {
    const prev = this.state
    this.state = { ...prev, ...next }
    if (next.hop !== undefined && next.hop !== prev.hop && prev.hop !== undefined) this.hop(false)
    if (next.mood && next.mood !== prev.mood) {
      if (next.mood === 'celebrate') this.hop(true)
      if (next.mood === 'wave' || next.mood === 'celebrate') this.waveAt = performance.now()
      // A blink hides the change of expression.
      this.blinkAt = performance.now()
    }
  }

  private hop(big: boolean) {
    this.hopAt = performance.now()
    this.hopBig = big
  }

  /** Canvas pixels to the body's radius. */
  private ppu(): number {
    return this.canvas.height / (1 + HEADROOM) / FRAMES[this.opts.framing].height
  }

  private resize() {
    const w = this.canvas.clientWidth || 1
    const h = this.canvas.clientHeight || 1
    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    this.canvas.width = Math.max(1, Math.round(w * dpr))
    this.canvas.height = Math.max(1, Math.round(h * dpr))
    // The rendered sheet nearest this size (a bigger one loads if Roo grows).
    const want = pickSheet(this.ppu())
    if (want !== this.sheet && want !== this.loading && (!this.sheet || SHEETS[want].ppu > SHEETS[this.sheet].ppu)) this.load(want)
    this.draw()
  }

  private load(name: SheetName) {
    this.loading = name
    const img = new Image()
    img.decoding = 'async'
    img.src = URLS[name]
    img
      .decode()
      .then(() => {
        if (this.disposed) return
        this.img = img
        this.sheet = name
        this.loading = null
        this.start()
      })
      .catch(() => {
        if (this.disposed || this.img) return
        this.dispose()
        this.opts.onFail()
      })
  }

  private onPointer = (e: PointerEvent) => {
    const r = this.host.getBoundingClientRect()
    if (!r.width) return
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height * 0.42)
    const d = Math.hypot(dx, dy) || 1
    const reach = Math.min(1, d / 300)
    this.pointer = { x: (dx / d) * reach, y: (-dy / d) * reach, at: performance.now() }
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.start()
  }

  private start() {
    if (this.raf || !this.img || !this.visible || document.visibilityState !== 'visible') return
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.tick)
  }

  private tick = (now: number) => {
    this.raf = 0
    if (!this.visible || document.visibilityState !== 'visible') return
    const dt = Math.min(0.05, (now - this.last) / 1000)
    const busy = this.update(dt, now)
    // A small, settled Roo draws every other frame.
    this.frameSkip = !this.frameSkip
    if (busy || !this.opts.quiet || this.frameSkip) {
      this.last = now
      this.draw()
      if (!this.readyCalled) {
        this.readyCalled = true
        this.opts.onReady()
      }
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  /** One step of every spring. Returns true while something is moving fast (talking, hopping, waving). */
  private update(dt: number, now: number): boolean {
    const s = this.s
    const p = this.pose
    const face = FACES[this.state.mood]
    const t = now / 1000

    // Breathing, slow and small.
    p.breath = 1 + 0.017 * Math.sin(2 * Math.PI * 0.25 * t)

    // A hop: crouch, spring up stretched, fall, land squashed, wobble. The big one is a celebration.
    let hopTarget = 0
    let squashTarget = 1
    const since = now - this.hopAt
    const hopping = this.hopAt >= 0 && since < 650
    if (hopping) {
      const k = since / 650
      const height = this.hopBig ? 0.42 : 0.2
      if (k < 0.14) squashTarget = 0.9
      else if (k < 0.5) {
        hopTarget = height * Math.sin(((k - 0.14) / 0.72) * Math.PI)
        squashTarget = 1.08
      } else if (k < 0.86) {
        hopTarget = height * Math.sin(((k - 0.14) / 0.72) * Math.PI)
        squashTarget = 1.03
      } else squashTarget = 0.88
    }
    p.hopY = s.hopY.to(hopTarget, dt)
    p.squash = s.squash.to(squashTarget, dt)

    // Where Roo looks: the mood's own look, else the pointer, else a glance about now and then.
    let look: [number, number]
    if (face.look) look = face.look
    else if (now - this.pointer.at < 3500) look = [this.pointer.x, this.pointer.y]
    else {
      if (now > this.nextGlance) {
        this.glance = { x: Math.random() < 0.5 ? -0.6 : 0.6, y: Math.random() < 0.5 ? 0.25 : -0.15, until: now + 1200 }
        this.nextGlance = now + 4500 + Math.random() * 3000
        this.blinkAt = now
      }
      look = now < this.glance.until ? [this.glance.x, this.glance.y] : [0, 0]
    }
    p.gaze = [s.gazeX.to(look[0], dt), s.gazeY.to(look[1], dt)]
    const hx = s.headX.to(look[0], dt)
    const hy = s.headY.to(look[1], dt)
    p.tilt = s.tilt.to(face.tilt, dt)

    // Blinks every few seconds (sometimes twice), and on every change of mood.
    if (now > this.nextBlink) {
      this.blinkAt = now
      this.nextBlink = now + 2200 + Math.random() * 2600 + (Math.random() < 0.12 ? -1800 : 0)
    }
    const b = now - this.blinkAt
    p.blink = b < 0 ? 1 : b < 60 ? 1 - b / 60 : b < 100 ? 0 : b < 210 ? (b - 100) / 110 : 1

    p.eyesOpen = s.eyesOpen.to(face.eyesOpen, dt)
    p.happy = s.happy.to(face.happy, dt)
    p.sleep = s.sleep.to(face.sleep, dt)
    p.wide = s.wide.to(face.wide, dt)
    p.brows = s.brows.to(face.brows, dt)
    p.browTilt = s.browTilt.to(face.browTilt, dt)
    p.cheeks = s.cheeks.to(face.cheeks, dt)

    // Arms: a wave with the right hand (1.2 s), both up to celebrate, otherwise hanging and swaying.
    const waving = this.waveAt >= 0 && now - this.waveAt < 1200
    const wavePhase = waving ? Math.sin(((now - this.waveAt) / 1000) * 2 * Math.PI * 1.6) : 0
    const celebrating = this.state.mood === 'celebrate'
    const sway = 0.04 * Math.sin(t * 1.3)
    p.armR = s.armR.to(celebrating ? 1.75 : waving ? 1.15 + 0.4 * wavePhase : sway, dt)
    p.armL = s.armL.to(celebrating ? 1.75 : this.state.mood === 'thinking' ? 0.3 : -sway, dt)

    // The sprout lags behind the body: follow-through when Roo hops, a droop when it thinks.
    p.leaf = s.leaf.to(face.leaf - s.hopY.v * 0.35 + 0.03 * Math.sin(t * 1.7), dt)

    // The mouth: the voice's shape while Roo talks, else the mood's.
    const said = mouthNow()
    const target = said ?? face.mouth
    const open = s.open.to(target.open, dt)
    const mouth = { open: Math.max(0, open), wide: s.wideM.to(target.wide, dt), round: s.round.to(target.round, dt), smile: s.smile.to(target.smile, dt) }
    p.mouth = said ? mix(mouth, target, 0.35) : mouth

    // The head follows the gaze and nods a little on loud words; its face slides over the round body.
    p.yaw = hx * 0.24
    p.pitch = -hy * 0.12 + (said ? said.open * 0.035 : 0)

    return !!said || hopping || waving || this.state.mood === 'listening'
  }

  /** Draws a rendered piece where it sits (in the master render's pixels). */
  private piece(key: string, alpha = 1) {
    const r = SHEETS[this.sheet!].rects[key]
    const [x, y, w, h] = PIECES[key].rect
    if (!r || alpha <= 0.004) return
    this.ctx.globalAlpha = alpha
    this.ctx.drawImage(this.img!, r[0], r[1], r[2], r[3], x, y, w, h)
  }

  /** Draws a face piece where the head's turn has slid it, squeezed as it turns away from you; `local`
   *  transforms it about its own centre (a blink, a brow's tilt). */
  private facePiece(key: string, alpha: number, local?: (ctx: CanvasRenderingContext2D) => void) {
    if (alpha <= 0.004) return
    const { anchor, normal } = PIECES[key]
    const { yaw, pitch } = this.pose
    const [x0, y0] = project(anchor!)
    const [x1, y1] = project(turn(anchor!, yaw, pitch))
    const view = RIG.camera.toward
    const k = Math.max(0.3, Math.min(1.6, -dot(turn(normal!, yaw, pitch), view) / Math.max(0.05, -dot(normal!, view))))
    let ux = dot(normal!, RIG.camera.right)
    let uy = -dot(normal!, RIG.camera.up)
    const ul = Math.hypot(ux, uy) || 1
    ux /= ul
    uy /= ul
    const ctx = this.ctx
    ctx.save()
    ctx.translate(x1, y1)
    ctx.transform(1 + (k - 1) * ux * ux, (k - 1) * ux * uy, (k - 1) * ux * uy, 1 + (k - 1) * uy * uy, 0, 0)
    local?.(ctx)
    ctx.translate(-x0, -y0)
    this.piece(key, alpha)
    ctx.restore()
  }

  /** An arm at `raise`: the two rendered poses either side, each turned the rest of the way about the shoulder,
   *  the nearer drawn whole and the other faded over it. */
  private arm(side: 'L' | 'R', raise: number) {
    const { a, b, t } = armPoses(side, raise)
    const spin = side === 'R' ? -1 : 1
    const draw = (key: string, alpha: number) => {
      const { pivot, raise: posed } = PIECES[key]
      const ctx = this.ctx
      ctx.save()
      ctx.translate(pivot![0], pivot![1])
      ctx.rotate(spin * (raise - posed!))
      ctx.translate(-pivot![0], -pivot![1])
      this.piece(key, alpha)
      ctx.restore()
    }
    if (t < 0.5) {
      draw(a, 1)
      draw(b, t)
    } else {
      draw(b, 1)
      draw(a, 1 - t)
    }
  }

  private path(pts: Pt[]) {
    const ctx = this.ctx
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.closePath()
  }

  /** The felt mouth, cut to the voice's shape from rendered felt, with its tongue, over a soft shadow. */
  private mouth() {
    const ctx = this.ctx
    const { mouth, yaw, pitch } = this.pose
    const pts = mouthPoints(mouth, yaw, pitch)
    // Where the felt has slid to as the head turns.
    const anchor = PIECES['Felt Black'].anchor!
    const [ax, ay] = project(anchor)
    const [bx, by] = project(turn(anchor, yaw, pitch))
    // Its shadow on the fur: the outline, faint and a little lower, twice (a blurred shadow costs a phone
    // more than the rest of Roo).
    ctx.globalAlpha = 1
    for (const [drop, shade] of [
      [0.014, 0.1],
      [0.007, 0.2],
    ]) {
      ctx.save()
      ctx.translate(0, drop * RIG.ppu)
      this.path(pts)
      ctx.fillStyle = `rgba(0, 0, 0, ${shade})`
      ctx.fill()
      ctx.restore()
    }
    ctx.save()
    this.path(pts)
    ctx.clip()
    ctx.translate(bx - ax, by - ay)
    this.piece('Felt Black')
    const tongue = Math.max(0, Math.min(1, (mouth.open - 0.22) / 0.15))
    if (tongue > 0) {
      ctx.translate(ax - bx, ay - by)
      this.path(tonguePoints(mouth, yaw, pitch))
      ctx.clip()
      ctx.translate(bx - ax, by - ay)
      this.piece('Felt Tongue', tongue)
    }
    ctx.restore()
    // The felt's cut edge catches a little light.
    ctx.save()
    this.path(pts)
    ctx.globalAlpha = 1
    ctx.lineWidth = 0.006 * RIG.ppu
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
    ctx.stroke()
    ctx.restore()
  }

  private draw() {
    const ctx = this.ctx
    const { width: W, height: H } = this.canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, W, H)
    if (!this.img || !this.sheet) return
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const p = this.pose
    const frame = FRAMES[this.opts.framing]
    // Master-render pixels to canvas pixels, the framing's middle at the middle of Roo's box.
    const scale = this.ppu() / RIG.ppu
    const [mx, my] = project([0, 0, frame.middle])
    ctx.setTransform(scale, 0, 0, scale, W / 2 - mx * scale, (H * (HEADROOM + 0.5)) / (1 + HEADROOM) - my * scale)

    const [gx, gy] = project([0, 0, RIG.body.ground])
    const [cx, cy] = project([0, 0, 0])

    // The contact shadow stays on the ground, smaller and fainter while Roo is in the air.
    const lift = Math.min(0.35, p.hopY * 0.8)
    const shadow = PIECES.shadow.rect
    const sx = shadow[0] + shadow[2] / 2
    ctx.save()
    ctx.translate(sx, gy)
    ctx.scale(1 - lift, 1 - lift)
    ctx.translate(-sx, -gy)
    this.piece('shadow', 1 - Math.min(0.5, p.hopY))
    ctx.restore()

    // Roo: up in the hop, squashed or stretched from its feet, breathing, and tilted with its mood.
    ctx.save()
    ctx.translate(0, -p.hopY * RIG.ppu)
    ctx.translate(gx, gy)
    ctx.scale(1 / Math.sqrt(p.squash), p.squash * p.breath)
    ctx.translate(-gx, -gy)
    ctx.translate(cx, cy)
    ctx.rotate(-p.tilt)
    ctx.translate(-cx, -cy)

    // Behind the body, whose fuzzy edge covers where they join: the sprout, swaying about the top of the head,
    // and the arms.
    const sprout = PIECES.sprout.pivot!
    ctx.save()
    ctx.translate(sprout[0], sprout[1])
    ctx.rotate(-p.leaf)
    ctx.translate(-sprout[0], -sprout[1])
    this.piece('sprout')
    ctx.restore()
    this.arm('L', p.armL)
    this.arm('R', p.armR)
    this.piece('body')

    // The face: felt cheeks (a touch fuller when Roo's pleased), stitched eyes (open, happy or asleep) and
    // brows, then the mouth.
    for (const side of ['L', 'R'] as const) this.facePiece(`Cheek.${side}`, 1, (c) => c.scale(0.92 + 0.08 * p.cheeks, 0.92 + 0.08 * p.cheeks))
    const openY = Math.max(0.04, p.eyesOpen * Math.max(0.06, p.blink)) * p.wide
    const [lx, ly] = [p.gaze[0] * 0.016 * RIG.ppu, -p.gaze[1] * 0.012 * RIG.ppu]
    for (const side of ['L', 'R'] as const) {
      if (openY > 0.05)
        this.facePiece(`Eye Open.${side}`, 1, (c) => {
          c.translate(lx, ly)
          c.scale(p.wide, openY)
        })
      this.facePiece(`Eye Happy.${side}`, Math.min(1, p.happy * 1.4), (c) => c.scale(0.7 + 0.3 * p.happy, 0.7 + 0.3 * p.happy))
      this.facePiece(`Eye Sleep.${side}`, Math.min(1, p.sleep * 1.4), (c) => c.scale(0.7 + 0.3 * p.sleep, 0.7 + 0.3 * p.sleep))
      this.facePiece(`Brow.${side}`, Math.min(1, p.brows * 1.4), (c) => c.rotate((side === 'R' ? -1 : 1) * p.browTilt))
    }
    this.mouth()
    ctx.restore()
    ctx.globalAlpha = 1
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.raf = 0
    window.removeEventListener('pointermove', this.onPointer)
    window.removeEventListener('pointerdown', this.onPointer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.observers.forEach((o) => o.disconnect())
    this.img = null
    this.canvas.remove()
  }
}
