// Roo in 3D: the plush toy rendered in Blender (frontend/roo3d/: real fur, a stitched face, felt), drawn here
// with WebGL from the rendered pieces and moved with springs. It breathes, blinks, hops each time it speaks,
// waves, and turns its whole body to look at your pointer, like a real toy turned in your hands: each frame its
// face is put together on its fur (stitched eyes, felt cheeks, and the felt mouth cut to the shape
// lib/speech/channel.ts says Roo is making), then the round body is turned as one, the face with it, and its
// arms, feet and sprout go round with it. What it feels and does (each mood's face, giggling when poked,
// purring when stroked, fidgets of its own, the felt emotes floating off it) is in life.ts. It draws only
// while it's on screen.

import type { Mood } from '@/components/roo/RooArt'
import { mix, mouthOutline, mouthSize, REST, type MouthParams } from '@/lib/roo/lipsync/mouth'
import { mouthNow } from '@/lib/speech/channel'
import lg from './assets/roo-lg.webp'
import md from './assets/roo-md.webp'
import sm from './assets/roo-sm.webp'
import { ACTS, emoteNow, FACES, fidget, GRIN, perform, still, type Act, type Emote, type Face } from './life'
import { PIECES, RIG, SHEETS, type Rect } from './rig'

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

/** How far Roo turns to look at your pointer (radians, at full reach): round to the side, and up or down. */
const TURN = 0.34
const NOD = 0.16
/** And how far it leans into the turn. */
const LEAN = 0.04
const TAU = 2 * Math.PI

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

/** The turn as one rotation: the axis it turns about, and how far (radians). */
export function turnAxis(yaw: number, pitch: number): { axis: Vec3; angle: number } {
  const [x, y, z] = [turn([1, 0, 0], yaw, pitch), turn([0, 1, 0], yaw, pitch), turn([0, 0, 1], yaw, pitch)]
  const angle = Math.acos(Math.max(-1, Math.min(1, (x[0] + y[1] + z[2] - 1) / 2)))
  const sin = 2 * Math.sin(angle)
  if (sin < 1e-6) return { axis: [0, 0, 1], angle: 0 }
  return { axis: [(y[2] - z[1]) / sin, (z[0] - x[2]) / sin, (x[1] - y[0]) / sin], angle }
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
/** The mouth's outline is the top lip left to right, then the bottom lip back: the points facing each other
 *  across it, pair by pair (the corners pair with themselves). */
const MOUTH_PAIRS = Int8Array.from({ length: MOUTH_POINTS + 2 }, (_, i) => {
  const k = i >> 1
  return i % 2 === 0 || k === 0 || k === MOUTH_POINTS / 2 ? k : MOUTH_POINTS - k
})
/** The tongue's 24 points go round from its right end: those facing each other top and bottom. */
const TONGUE_PAIRS = Int8Array.from({ length: 26 }, (_, i) => (i % 2 === 0 ? i >> 1 : (24 - (i >> 1)) % 24))

/** The felt mouth's outline in the master render's pixels, for a turn of the head. */
export function mouthPoints(p: MouthParams, yaw: number, pitch: number): Pt[] {
  const { mouthUnit, mouthZ, faceLift } = RIG.body
  return mouthOutline(p, MOUTH_POINTS).map(([x, y]) => project(turn(onBody(x * mouthUnit, mouthZ - y * mouthUnit, faceLift + FELT), yaw, pitch)))
}

/** The felt tongue: an oval low in the mouth, cut off by the bottom lip (the top lip is always above it); and
 *  which of its points the lip cut. */
export function tonguePoints(p: MouthParams, yaw: number, pitch: number): { pts: Pt[]; cut: boolean[] } {
  const { mouthUnit, mouthZ, faceLift } = RIG.body
  const { halfWidth, height, dip } = mouthSize(p)
  const lip = dip + 0.75 * height
  const pts: Pt[] = []
  const cut: boolean[] = []
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI
    const x = 0.55 * halfWidth * Math.cos(a)
    const y = dip + 0.66 * height + 0.36 * height * Math.sin(a)
    // The bottom lip, below this point (y is down).
    const edge = lip * (1 - (x / halfWidth) ** 2)
    pts.push(project(turn(onBody(x * mouthUnit, mouthZ - Math.min(y, edge) * mouthUnit, faceLift + FELT + 0.004), yaw, pitch)))
    cut.push(y > edge)
  }
  return { pts, cut }
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

// ---------- drawing ----------

/** A 2D transform as the canvas keeps one: x' = a x + c y + e, y' = b x + d y + f. */
type Mat = readonly [a: number, b: number, c: number, d: number, e: number, f: number]
const IDENTITY: Mat = [1, 0, 0, 1, 0, 0]

/** `m` after `n` (n applies first), as the canvas's transform() does. */
function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]
}
const moved = (m: Mat, x: number, y: number) => mul(m, [1, 0, 0, 1, x, y])
const scaled = (m: Mat, x: number, y: number) => mul(m, [x, 0, 0, y, 0, 0])
const turned = (m: Mat, a: number) => mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0])
/** `m` with `f` done about the point (x, y). */
const about = (m: Mat, x: number, y: number, f: (m: Mat) => Mat) => moved(f(moved(m, x, y)), -x, -y)

// Pieces of a texture (or flat colour, from a white pixel), each vertex with its own opacity.
const SPRITE_VS = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute float aAlpha;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = aUv;
  vAlpha = aAlpha;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const SPRITE_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec4 uTint;
varying vec2 vUv;
varying float vAlpha;
void main() {
  gl_FragColor = texture2D(uTex, vUv) * uTint * vAlpha;
}`

// The body, turned. For each pixel, the point of the body's front it shows (where the camera's view meets the
// body's ellipsoid) is turned back to where it was rendered and looked up there: all the way in the middle, less
// and less towards the outline, which stays put. So the fuzzy edge stays whole, and the side coming into view
// stretches a little rather than folding over. The rendered shading (a smooth fit of it, by which way the
// surface faces) is swapped for the shading where the point is now, so the lights stay put as Roo turns.
const WARP_VS = `
attribute vec2 aPos;
attribute vec2 aUv;
varying vec2 vM;
void main() {
  vM = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

const WARP_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex;
uniform vec4 uRect;
uniform vec2 uCentre;
uniform float uPpu;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uToward;
uniform vec3 uRadii;
uniform vec3 uAxis;
uniform float uAngle;
uniform float uDepth;
uniform float uShade[9];
varying vec2 vM;

float shade(vec3 n) {
  return uShade[0] + uShade[1] * n.x + uShade[2] * n.y + uShade[3] * n.z + uShade[4] * n.x * n.y + uShade[5] * n.x * n.z
    + uShade[6] * n.y * n.z + uShade[7] * (n.x * n.x - n.y * n.y) + uShade[8] * (3.0 * n.z * n.z - 1.0);
}

void main() {
  vec2 q = vM;
  float k = 1.0;
  vec2 uv = vec2(vM.x - uCentre.x, uCentre.y - vM.y) / uPpu;
  vec3 o = uv.x * uRight + uv.y * uUp;
  vec3 oi = o / uRadii;
  vec3 di = uToward / uRadii;
  float a = dot(di, di);
  float b = 2.0 * dot(oi, di);
  float disc = b * b - 4.0 * a * (dot(oi, oi) - 1.0);
  if (disc > 0.0) {
    float depth = sqrt(disc) / (2.0 * a);
    vec3 x = o + (-b / (2.0 * a) - depth) * uToward;
    float beta = -uAngle * (1.0 - pow(1.0 - clamp(depth / uDepth, 0.0, 1.0), 1.5));
    float c = cos(beta);
    vec3 x0 = x * c + cross(uAxis, x) * sin(beta) + uAxis * dot(uAxis, x) * (1.0 - c);
    q = uCentre + vec2(dot(x0, uRight), -dot(x0, uUp)) * uPpu;
    vec3 r2 = uRadii * uRadii;
    k = clamp(shade(normalize(x / r2)) / max(shade(normalize(x0 / r2)), 0.05), 0.6, 1.6);
  }
  vec2 st = vec2((q.x - uRect.x) / uRect.z, 1.0 - (q.y - uRect.y) / uRect.w);
  vec4 c = texture2D(uTex, st);
  float inside = step(0.0, st.x) * step(st.x, 1.0) * step(0.0, st.y) * step(st.y, 1.0);
  gl_FragColor = vec4(min(c.rgb * k, vec3(c.a)), c.a) * inside;
}`

interface Program {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

/** Somewhere to draw: its size in pixels, and master-render pixels to its pixels. */
interface Target {
  w: number
  h: number
  m: Mat
}

/** A picture drawn on the GPU, then drawn from: the face (Roo's front at rest). */
interface Picture {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
  w: number
  h: number
  /** Where it sits, in master-render pixels. */
  rect: Rect
}

/** Each vertex: where (clip space), where in its texture, and how opaque. */
const STRIDE = 5
const WHITE = [1, 1, 1, 1] as const
const BLACK = [0, 0, 0, 1] as const

// ---------- the engine ----------

export class RooEngine {
  private host: HTMLElement
  private canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private sprite: Program
  private warp: Program
  private buffer: WebGLBuffer
  /** Vertices waiting to be drawn, and how many. */
  private verts = new Float32Array(STRIDE * 1024)
  private count = 0
  /** The GPU's program, texture and tint now, so they're only set when they change. */
  private using: { prog: Program | null; tex: WebGLTexture | null; tint: readonly number[] | null } = { prog: null, tex: null, tint: null }
  /** What the face looked like when it was last put together (it's only redone when it changes). */
  private faceKey = ''
  /** Scratch space: an outline's normals, and the tongue's edge. */
  private nx = new Float32Array(64)
  private ny = new Float32Array(64)
  private edge = new Float32Array(24)
  private sheet: SheetName | null = null
  private img: HTMLImageElement | null = null
  private loading: SheetName | null = null
  /** The sheet of rendered pieces, and a white pixel for flat colours, on the GPU. */
  private atlas: WebGLTexture | null = null
  private white: WebGLTexture
  /** Roo's front at rest, put together (fur, then the face) whenever it changes, before it's turned. */
  private facePicture: Picture | null = null
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
  /** A darting of the eyes now and then, while they're not on anything. */
  private saccade: { x: number; y: number; next: number } = { x: 0, y: 0, next: 0 }
  /** What Roo's doing beyond its mood (a giggle, a fidget), and since when. */
  private act: { kind: Act; at: number } | null = null
  private nextFidget = performance.now() + 6000
  /** When something last happened (the pointer moved, the mood changed, Roo spoke): it fidgets, and in time
   *  yawns, when nothing has for a while. */
  private quietSince = performance.now()
  /** Since when the pointer has rested on Roo (0: it hasn't), and when it last poked it. */
  private hoverSince = 0
  private boopAt = -1e9
  /** A poke makes the app celebrate for a moment: Roo giggles instead, until then. */
  private giggleUntil = 0
  /** The extra hops of a celebration still to come. */
  private hops: number[] = []
  private emotes: Emote[] = []
  private nextZ = 0
  private zs = 0
  private nextSparkle = 0
  private nextHeart = 0
  /** The time of the latest update, for drawing. */
  private now = performance.now()
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
    star: new Spring(0, 3.5, 0.85),
    heart: new Spring(0, 3.5, 0.85),
    squint: new Spring(0, 6, 0.9),
    wink: new Spring(0, 9, 0.9),
    blush: new Spring(0, 3, 0.9),
    sweat: new Spring(0, 3, 0.9),
    mouthShift: new Spring(0, 3, 0.9),
    zoom: new Spring(1, 3, 0.7),
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
    star: 0,
    heart: 0,
    squint: 0,
    wink: 0,
    blush: 0,
    sweat: 0,
    mouthShift: 0,
    leaf: 0,
    armL: 0,
    armR: 0,
    mouth: REST as MouthParams,
    /** The body's roll (clockwise), bob up and how near it's come, on top of the rest. */
    roll: 0,
    bob: 0,
    zoom: 1,
  }

  constructor(
    host: HTMLElement,
    private opts: EngineOptions,
  ) {
    this.host = host
    this.canvas = document.createElement('canvas')
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.style.cssText = `position:absolute;left:${-ELBOWROOM * 100}%;top:${-HEADROOM * 100}%;display:block;width:${(1 + 2 * ELBOWROOM) * 100}%;height:${(1 + HEADROOM) * 100}%;pointer-events:none`
    const gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false })
    if (!gl) throw new Error('No WebGL')
    this.gl = gl
    this.sprite = this.program(SPRITE_VS, SPRITE_FS, ['uTint'])
    this.warp = this.program(WARP_VS, WARP_FS, ['uRect', 'uCentre', 'uPpu', 'uRight', 'uUp', 'uToward', 'uRadii', 'uAxis', 'uAngle', 'uDepth', 'uShade'])
    this.buffer = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW)
    for (const [slot, size, offset] of [
      [0, 2, 0],
      [1, 2, 8],
      [2, 1, 16],
    ]) {
      gl.enableVertexAttribArray(slot)
      gl.vertexAttribPointer(slot, size, gl.FLOAT, false, STRIDE * 4, offset)
    }
    this.white = this.texture()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    // What the turned body's shader needs to know that never changes.
    const u = this.warp.uniforms
    const { camera, body } = RIG
    const rect = PIECES.body.rect
    gl.useProgram(this.warp.program)
    gl.uniform4f(u.uRect, rect[0], rect[1], rect[2], rect[3])
    gl.uniform2f(u.uCentre, camera.centre[0], camera.centre[1])
    gl.uniform1f(u.uPpu, RIG.ppu)
    gl.uniform3fv(u.uRight, camera.right)
    gl.uniform3fv(u.uUp, camera.up)
    gl.uniform3fv(u.uToward, camera.toward)
    gl.uniform3fv(u.uRadii, body.radii)
    // How deep the body is along the view at its middle (where the turn is whole).
    gl.uniform1f(u.uDepth, 1 / Math.hypot(...camera.toward.map((v, i) => v / body.radii[i])))
    gl.uniform1fv(u.uShade, body.shade)
    this.using.prog = this.warp
    this.canvas.addEventListener('webglcontextlost', this.onLost)
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
    const now = performance.now()
    if (next.hop !== undefined && next.hop !== prev.hop && prev.hop !== undefined) this.hop(false)
    if (next.mood && next.mood !== prev.mood) {
      // A blink hides the change of expression; what the last mood floated off (Zzz, a !) goes.
      this.blinkAt = now
      this.quietSince = now
      for (const e of this.emotes) if (e.key === 'Emote Z' || e.key === 'Emote Exclaim') e.until = Math.min(e.until, now + 300)
      if (next.mood === 'celebrate') {
        // Just poked, the app celebrates for a moment: Roo giggles instead.
        if (now - this.boopAt < 700) this.giggleUntil = now + 1200
        else {
          this.hop(true)
          this.hops = [now + 750, now + 1450]
          this.waveAt = now
          for (const side of [-1, 1]) this.emit('Emote Heart', now, { ms: 1700, x: 0.3 * side, z: 1.0, dx: 0.12 * side, dz: 0.6, size: 0.8, spin: side })
        }
      }
      if (next.mood === 'wave') {
        this.waveAt = now
        this.emit('Emote Heart', now, { ms: 1700, x: 0.45, z: 1.0, dx: 0.12, dz: 0.6, size: 0.75, spin: 1 })
      }
      if (next.mood === 'alert') {
        this.begin('startle', now)
        this.emit('Emote Exclaim', now, { ms: 2600, x: 0.6, z: 1.2, size: 0.95, how: 'pop', spin: 1 })
      }
    }
  }

  /** Starts an act (life.ts). */
  private begin(kind: Act, now: number) {
    this.act = { kind, at: now }
    if (ACTS[kind].hop) this.hop(false)
    if (kind === 'wink') this.emit('Emote Sparkle', now + 120, { ms: 650, x: 0.6, z: 0.45, size: 0.5, how: 'twinkle', spin: 1 })
  }

  /** Floats a felt emote off Roo (where and how: see life.ts). */
  private emit(key: string, now: number, o: Partial<Emote> & { ms: number }) {
    if (!PIECES[key]) return
    const { ms, ...rest } = o
    this.emotes.push({ key, born: now, until: now + ms, x: 0, z: 1, dx: 0, dz: 0, size: 1, how: 'float', spin: 0, ...rest })
  }

  /** Poked: a giggle, or a start awake when asleep. */
  private boop(now: number) {
    this.boopAt = now
    if (this.state.mood === 'sleeping') {
      this.begin('startle', now)
      this.emit('Emote Exclaim', now, { ms: 900, x: 0.6, z: 1.2, size: 0.8, how: 'pop', spin: 1 })
      return
    }
    this.begin('boop', now)
    for (const side of [-1, 1]) this.emit('Emote Sparkle', now + 60, { ms: 700, x: 0.75 * side, z: 0.75, dz: 0.1, size: 0.6, how: 'twinkle', spin: side })
  }

  private hop(big: boolean) {
    this.hopAt = performance.now()
    this.hopBig = big
  }

  // ---------- the GPU ----------

  private program(vs: string, fs: string, uniforms: string[]): Program {
    const gl = this.gl
    const shader = (kind: number, src: string) => {
      const s = gl.createShader(kind)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const program = gl.createProgram()!
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vs))
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs))
    // Every program reads the one vertex buffer, laid out the same way: set up once, in the constructor.
    gl.bindAttribLocation(program, 0, 'aPos')
    gl.bindAttribLocation(program, 1, 'aUv')
    gl.bindAttribLocation(program, 2, 'aAlpha')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(program) ?? 'program')
    return { program, uniforms: Object.fromEntries(uniforms.map((u) => [u, gl.getUniformLocation(program, u)])) }
  }

  private texture(): WebGLTexture {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    this.using.tex = tex
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  /** A picture to draw into and then from, covering `rect` (master-render pixels) at `w` by `h`. */
  private picture(rect: Rect, w: number, h: number): Picture {
    const gl = this.gl
    const tex = this.texture()
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (!ok && !gl.isContextLost()) throw new Error('Framebuffer')
    return { fbo, tex, w, h, rect }
  }

  /** Draws into `picture` from now on (the screen's canvas when null), cleared. */
  private bind(picture: Picture | null) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, picture?.fbo ?? null)
    gl.viewport(0, 0, picture?.w ?? this.canvas.width, picture?.h ?? this.canvas.height)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Where `picture`'s pixels are, for drawing into it. */
  private into(picture: Picture): Target {
    const [x, y, w, h] = picture.rect
    const kx = picture.w / w
    const ky = picture.h / h
    return { w: picture.w, h: picture.h, m: [kx, 0, 0, ky, -x * kx, -y * ky] }
  }

  /** Queues a vertex: (x, y) in master-render pixels, placed by `m` on `target`. */
  private vertex(target: Target, m: Mat, x: number, y: number, u: number, v: number, alpha: number) {
    if ((this.count + 1) * STRIDE > this.verts.length) {
      const more = new Float32Array(this.verts.length * 2)
      more.set(this.verts)
      this.verts = more
      this.gl.bufferData(this.gl.ARRAY_BUFFER, more.byteLength, this.gl.DYNAMIC_DRAW)
    }
    const o = this.count++ * STRIDE
    const out = this.verts
    out[o] = ((m[0] * x + m[2] * y + m[4]) * 2) / target.w - 1
    out[o + 1] = 1 - ((m[1] * x + m[3] * y + m[5]) * 2) / target.h
    out[o + 2] = u
    out[o + 3] = v
    out[o + 4] = alpha
  }

  /** Queues `src` (a rectangle of a texture `size` pixels big; its texture coordinates are master-render pixels
   *  when `size` is null) drawn over `dst`, placed by `m`. */
  private quad(target: Target, m: Mat, dst: Rect, src: Rect, size: readonly [number, number] | null, alpha = 1) {
    if (alpha <= 0.004) return
    const t = mul(target.m, m)
    const [x, y, w, h] = dst
    const [sw, sh] = size ?? [1, 1]
    const u0 = src[0] / sw
    const v0 = src[1] / sh
    const u1 = (src[0] + src[2]) / sw
    const v1 = (src[1] + src[3]) / sh
    this.vertex(target, t, x, y, u0, v0, alpha)
    this.vertex(target, t, x + w, y, u1, v0, alpha)
    this.vertex(target, t, x, y + h, u0, v1, alpha)
    this.vertex(target, t, x, y + h, u0, v1, alpha)
    this.vertex(target, t, x + w, y, u1, v0, alpha)
    this.vertex(target, t, x + w, y + h, u1, v1, alpha)
  }

  /** Draws everything queued, from `tex`, its colours times `tint`. */
  private flush(tex: WebGLTexture, tint: readonly [number, number, number, number] = WHITE, prog = this.sprite) {
    if (!this.count) return
    const gl = this.gl
    const using = this.using
    if (using.prog !== prog) {
      gl.useProgram(prog.program)
      using.prog = prog
    }
    if (using.tex !== tex) {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      using.tex = tex
    }
    if (prog === this.sprite && using.tint !== tint) {
      gl.uniform4f(prog.uniforms.uTint, tint[0], tint[1], tint[2], tint[3])
      using.tint = tint
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts.subarray(0, this.count * STRIDE))
    gl.drawArrays(gl.TRIANGLES, 0, this.count)
    this.count = 0
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
        try {
          this.prepare()
        } catch {
          this.dispose()
          this.opts.onFail()
          return
        }
        this.start()
      })
      .catch(() => {
        if (this.disposed || this.img) return
        this.dispose()
        this.opts.onFail()
      })
  }

  /** The sheet's pieces on the GPU, and the face to put together, at its size. */
  private prepare() {
    const gl = this.gl
    const sheet = SHEETS[this.sheet!]
    if (this.facePicture) {
      gl.deleteFramebuffer(this.facePicture.fbo)
      gl.deleteTexture(this.facePicture.tex)
    }
    if (this.atlas) gl.deleteTexture(this.atlas)
    this.atlas = this.texture()
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.img!)
    this.faceKey = ''

    const [, , w, h] = sheet.rects.body
    this.facePicture = this.picture(PIECES.body.rect, w, h)
  }

  private onPointer = (e: PointerEvent) => {
    const r = this.host.getBoundingClientRect()
    if (!r.width) return
    const now = performance.now()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height * 0.42)
    const d = Math.hypot(dx, dy) || 1
    const reach = Math.min(1, d / 300)
    this.pointer = { x: (dx / d) * reach, y: (-dy / d) * reach, at: now }
    this.quietSince = now
    // On Roo: being stroked, or poked.
    const on = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
    this.hoverSince = on ? this.hoverSince || now : 0
    if (on && e.type === 'pointerdown') this.boop(now)
  }

  private onVisibility = () => {
    if (document.visibilityState === 'visible') this.start()
  }

  private onLost = () => {
    if (this.disposed) return
    this.dispose()
    this.opts.onFail()
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
    const mood = this.state.mood
    const t = now / 1000
    this.now = now
    const said = mouthNow()
    if (said) this.quietSince = now

    // The face to aim for: the mood's, changed by whatever Roo's doing (giggling when the app celebrates a poke).
    const giggling = mood === 'celebrate' && now < this.giggleUntil
    const face: Face = { ...FACES[giggling ? 'happy' : mood] }
    const m = still()

    // An act under way, else, when nothing's happening, now and then a fidget of its own.
    if (this.act && now - this.act.at > ACTS[this.act.kind].ms) {
      const done = this.act.kind
      this.act = null
      // A giggle sometimes ends in a wink.
      if (done === 'boop' && Math.random() < 0.4) this.begin('wink', now)
    }
    if (!this.act && !said && now > this.nextFidget && now - this.pointer.at > 2500) {
      const kind = fidget(mood, now - this.quietSince, Math.random())
      if (kind) this.begin(kind, now)
      this.nextFidget = now + 5500 + Math.random() * 5000
    }
    if (giggling && !this.act) this.begin('boop', now)
    if (this.act) {
      const ms = now - this.act.at
      perform(this.act.kind, ms / ACTS[this.act.kind].ms, ms / 1000, face, m)
    }

    // Stroked (the pointer resting on it): eyes closed happily, a blush, a little wriggle, now and then a heart.
    const stroked = this.hoverSince > 0 && now - this.hoverSince > 350 && now - this.pointer.at < 1500 && !said && !this.act && (mood === 'idle' || mood === 'happy' || mood === 'listening')
    if (stroked) {
      Object.assign(face, { eyesOpen: 0, happy: 1, blush: 0.8, cheeks: 1, mouth: GRIN })
      m.bob += 0.012 * (0.5 + 0.5 * Math.sin(TAU * 1.4 * t))
      m.roll += 0.02 * Math.sin(TAU * 1.1 * t)
      if (now > this.nextHeart) {
        const side = Math.random() < 0.5 ? -1 : 1
        this.emit('Emote Heart', now, { ms: 1700, x: 0.25 * side, z: 1.0 + p.hopY, dx: 0.1 * side, dz: 0.55, size: 0.7, spin: side })
        this.nextHeart = now + 2600
      }
    }

    // Each mood's own life.
    const cheering = mood === 'celebrate' && !giggling
    if (mood === 'happy') {
      m.roll += 0.03 * Math.sin(TAU * 0.45 * t)
      m.bob += 0.012 * (0.5 + 0.5 * Math.sin(TAU * 0.9 * t))
    } else if (mood === 'listening') {
      // Slow nods, its head tipped one way, then the other.
      m.nod += 0.055 * Math.max(0, Math.sin(TAU * 0.55 * t)) ** 2
      face.tilt = 0.1 * (Math.sin((TAU * t) / 7) > 0 ? 1 : -1)
    } else if (mood === 'thinking') {
      // Its eyes searching about up there, swaying as it ponders.
      face.look = Math.floor(t / 1.3) % 2 ? [-0.35, 0.6] : [-0.75, 0.78]
      m.roll += 0.025 * Math.sin(TAU * 0.35 * t)
    } else if (mood === 'alert') m.roll += 0.01 * Math.sin(TAU * 9 * t)
    else if (cheering) m.leaf += 0.25 * Math.sin(TAU * 3.2 * t)
    if (said) {
      // Talking: a bounce on loud sounds, and a sway.
      m.bob += said.open * 0.022
      m.roll += 0.022 * Math.sin(TAU * 0.7 * t)
    }

    // Breathing: slow and small, deeper asleep, the mouth falling open a little with each breath.
    const asleep = mood === 'sleeping'
    p.breath = 1 + (asleep ? 0.034 : 0.017) * Math.sin(TAU * (asleep ? 0.17 : 0.25) * t)
    if (asleep && !said) face.mouth = { ...face.mouth, open: 0.05 * (1 + Math.sin(TAU * 0.17 * t)) }

    // A hop: crouch, spring up stretched, fall, land squashed, wobble. The big one is a celebration, which
    // bounces twice more.
    if (this.hops.length && now >= this.hops[0]) {
      this.hops.shift()
      if (cheering) this.hop(false)
    }
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
    p.squash = s.squash.to(squashTarget * m.stretch, dt)
    p.zoom = s.zoom.to(m.zoom, dt)
    p.roll = m.roll
    p.bob = m.bob

    // Where Roo looks: where an act looks, else the mood's own look, else the pointer, else a glance about now
    // and then; its eyes darting a little when they're not on anything.
    let look: readonly [number, number]
    if (m.look) look = m.look
    else if (face.look) look = face.look
    else if (now - this.pointer.at < 3500) look = [this.pointer.x, this.pointer.y]
    else {
      if (now > this.nextGlance) {
        this.glance = { x: Math.random() < 0.5 ? -0.6 : 0.6, y: Math.random() < 0.5 ? 0.25 : -0.15, until: now + 1200 }
        this.nextGlance = now + 4500 + Math.random() * 3000
        this.blinkAt = now
      }
      look = now < this.glance.until ? [this.glance.x, this.glance.y] : [0, 0]
      if (now > this.saccade.next) this.saccade = { x: (Math.random() - 0.5) * 0.3, y: (Math.random() - 0.5) * 0.2, next: now + 1200 + Math.random() * 1200 }
    }
    const dart = now - this.pointer.at < 3500 || face.look ? [0, 0] : [this.saccade.x, this.saccade.y]
    p.gaze = [s.gazeX.to(look[0] + dart[0], dt), s.gazeY.to(look[1] + dart[1], dt)]
    const hx = s.headX.to(look[0], dt)
    const hy = s.headY.to(look[1], dt)
    p.tilt = s.tilt.to(face.tilt - look[0] * LEAN, dt)

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
    p.star = s.star.to(face.star, dt)
    p.heart = s.heart.to(face.heart, dt)
    p.squint = s.squint.to(face.squint, dt)
    p.wink = s.wink.to(face.wink, dt)
    p.wide = s.wide.to(face.wide, dt)
    p.brows = s.brows.to(face.brows, dt)
    p.browTilt = s.browTilt.to(face.browTilt, dt)
    p.cheeks = s.cheeks.to(face.cheeks, dt)
    p.blush = s.blush.to(face.blush, dt)
    p.sweat = s.sweat.to(face.sweat, dt)
    p.mouthShift = s.mouthShift.to(face.mouthShift, dt)

    // Arms: a wave with the right hand (1.2 s), both up and waving to celebrate, a hand to the chin tapping
    // as it thinks, up a little in alarm, otherwise hanging and swaying; unless an act moves them.
    const waving = this.waveAt >= 0 && now - this.waveAt < 1200
    const wavePhase = waving ? Math.sin(((now - this.waveAt) / 1000) * TAU * 1.6) : 0
    const sway = 0.04 * Math.sin(t * 1.3)
    const cheer = 0.25 * Math.sin(TAU * 2.2 * t)
    const lifted = mood === 'alert' ? 0.35 : mood === 'listening' ? 0.12 : 0
    let armR = cheering ? 1.6 - cheer : waving ? 1.15 + 0.4 * wavePhase : lifted + sway
    let armL = cheering ? 1.6 + cheer : mood === 'thinking' ? 0.3 + 0.05 * Math.sin(TAU * 2.6 * t) : lifted - sway
    if (m.armL !== null) armL = m.armL
    if (m.armR !== null) armR = m.armR
    p.armR = s.armR.to(armR, dt)
    p.armL = s.armL.to(armL, dt)

    // The sprout lags behind the body: follow-through when Roo hops, a droop when it thinks; and whatever an
    // act does to it.
    p.leaf = s.leaf.to(face.leaf - s.hopY.v * 0.35 + 0.03 * Math.sin(t * 1.7), dt) + m.leaf

    // The mouth: the voice's shape while Roo talks, else the mood's.
    const target = said ?? face.mouth
    const open = s.open.to(target.open, dt)
    const mouth = { open: Math.max(0, open), wide: s.wideM.to(target.wide, dt), round: s.round.to(target.round, dt), smile: s.smile.to(target.smile, dt) }
    p.mouth = said ? mix(mouth, target, 0.35) : mouth

    // The whole body turns after the gaze, and nods a little on loud words.
    p.yaw = hx * TURN + m.turn
    p.pitch = -hy * NOD + (said ? said.open * 0.035 : 0) + m.nod

    // Felt emotes: Zzz rising while it sleeps, a ? hanging over it while it thinks, sparkles to celebrate.
    if (asleep && now > this.nextZ) {
      this.emit('Emote Z', now, { ms: 2800, x: 0.4, z: 0.95 + p.hopY, dx: 0.32, dz: 0.62, size: [0.7, 0.85, 1][this.zs++ % 3], spin: 1 })
      this.nextZ = now + 1300
    }
    const asking = this.emotes.find((e) => e.key === 'Emote Question' && e.until > now + 300)
    if (mood === 'thinking' && !asking) this.emit('Emote Question', now, { ms: 1e9, x: 0.62, z: 1.18, size: 0.9, how: 'pop', spin: 1 })
    if (mood !== 'thinking' && asking) asking.until = now + 300
    if (cheering && now > this.nextSparkle) {
      const a = -0.3 + Math.random() * (Math.PI + 0.6)
      const r = 1.12 + Math.random() * 0.24
      this.emit('Emote Sparkle', now, { ms: 750, x: r * Math.cos(a), z: 0.1 + 0.95 * r * Math.sin(a) + p.hopY, dz: 0.08, size: 0.45 + 0.35 * Math.random(), how: 'twinkle', spin: Math.random() < 0.5 ? -1 : 1 })
      this.nextSparkle = now + 160
    }
    if (this.emotes.length) this.emotes = this.emotes.filter((e) => e.until > now)

    return !!said || hopping || waving || mood === 'listening' || !!this.act || stroked || cheering
  }

  // ---------- drawing ----------

  /** Queues a rendered piece where it sits, moved by `m`. */
  private piece(target: Target, key: string, m: Mat = IDENTITY, alpha = 1) {
    const sheet = SHEETS[this.sheet!]
    const r = sheet.rects[key]
    if (!r || !PIECES[key]) return
    this.quad(target, m, PIECES[key].rect, r, sheet.size, alpha)
  }

  /** Queues a face piece on the body at rest; `local` moves it about its middle (a blink, a brow's tilt). */
  private facePiece(target: Target, key: string, alpha: number, local: (m: Mat) => Mat) {
    const [x, y] = project(PIECES[key].anchor!)
    this.piece(target, key, about(IDENTITY, x, y, local), alpha)
  }

  /** How a part fixed to the body (a shoulder, the top of the head) moves as the body turns. */
  private carried(anchor: Vec3, yaw: number, pitch: number): Pt {
    const [x0, y0] = project(anchor)
    const [x1, y1] = project(turn(anchor, yaw, pitch))
    return [x1 - x0, y1 - y0]
  }

  /** An arm at `raise`: the two rendered poses either side, each turned the rest of the way about the shoulder,
   *  the nearer drawn whole and the other faded over it. As the body turns, the arm going away goes round behind
   *  it; the one coming towards you stays at the body's side (it's drawn behind the body's fuzzy edge). */
  private arm(target: Target, base: Mat, side: 'L' | 'R', raise: number) {
    const { a, b, t } = armPoses(side, raise)
    const spin = side === 'R' ? -1 : 1
    const { yaw, pitch } = this.pose
    const anchor = PIECES[a].anchor!
    const away = turn(anchor, yaw, pitch)[1] > anchor[1]
    const [cx, dy] = this.carried(anchor, yaw, pitch)
    const dx = away ? cx : 0
    const draw = (key: string, alpha: number) => {
      const { pivot, raise: posed } = PIECES[key]
      this.piece(target, key, about(moved(base, dx, dy), pivot![0], pivot![1], (m) => turned(m, spin * (raise - posed!))), alpha)
    }
    if (t < 0.5) {
      draw(a, 1)
      draw(b, t)
    } else {
      draw(b, 1)
      draw(a, 1 - t)
    }
  }

  /** Where a vertex at master-render (x, y) samples `key`'s rendered felt: u = a x + b, v = c y + d. */
  private swatch(key: string): readonly [number, number, number, number] {
    const atlas = SHEETS[this.sheet!]
    const [x, y, w, h] = PIECES[key].rect
    const r = atlas.rects[key]
    const [sw, sh] = atlas.size
    return [r[2] / w / sw, (r[0] - (x * r[2]) / w) / sw, r[3] / h / sh, (r[1] - (y * r[3]) / h) / sh]
  }

  /** The outward normals of a clockwise outline (clockwise on screen: out is to the left of the way round),
   *  `length` long, into `nx` and `ny`. */
  private normals(pts: Pt[], length: number) {
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const a = pts[(i + n - 1) % n]
      const b = pts[(i + 1) % n]
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      this.nx[i] = ((b[1] - a[1]) / l) * length
      this.ny[i] = (-(b[0] - a[0]) / l) * length
    }
  }

  /** Queues a filled outline, lowered by `dy`, at `alpha`, its edge fading out over `soft` (from `edge[i]`'s
   *  opacity at point i, where given), coloured from `uv` (u = a x + b, v = c y + d; flat when null). `pairs`
   *  says which points face each other across it: the inside is the bands between pair k and pair k + 1. */
  private fill(target: Target, pts: Pt[], pairs: Int8Array, dy: number, alpha: number, soft: number, uv: readonly number[] | null, edge?: Float32Array) {
    const [a, b, c, d] = uv ?? [0, 0.5, 0, 0.5]
    const put = (x: number, y: number, o: number) => this.vertex(target, target.m, x, y + dy, a * x + b, c * (y + dy) + d, o)
    for (let k = 0; k + 3 < pairs.length; k += 2) {
      const p = pts[pairs[k]]
      const r = pts[pairs[k + 1]]
      const q = pts[pairs[k + 2]]
      const s = pts[pairs[k + 3]]
      put(p[0], p[1], alpha)
      put(q[0], q[1], alpha)
      put(r[0], r[1], alpha)
      put(r[0], r[1], alpha)
      put(q[0], q[1], alpha)
      put(s[0], s[1], alpha)
    }
    this.normals(pts, soft)
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n
      const p = pts[i]
      const q = pts[j]
      const o0 = edge ? edge[i] : alpha
      const o1 = edge ? edge[j] : alpha
      const px = p[0] + this.nx[i]
      const py = p[1] + this.ny[i]
      put(p[0], p[1], o0)
      put(q[0], q[1], o1)
      put(px, py, 0)
      put(px, py, 0)
      put(q[0], q[1], o1)
      put(q[0] + this.nx[j], q[1] + this.ny[j], 0)
    }
  }

  /** The felt mouth, cut to the voice's shape from rendered felt, with its tongue, over a soft shadow; drawn on
   *  the face at rest (the body turns it with the rest of the face). Its edges fade out over a pixel, so they're
   *  smooth. */
  private drawMouth(target: Target) {
    const { mouth } = this.pose
    // A pixel of the face, in master-render pixels: how wide the soft edges are.
    const px = 1 / target.m[0]
    const shift = this.pose.mouthShift * RIG.ppu
    const pts = mouthPoints(mouth, 0, 0).map(([x, y]): Pt => [x + shift, y])
    // Its shadow on the fur: the outline, faint and a little lower, twice.
    this.fill(target, pts, MOUTH_PAIRS, 0.014 * RIG.ppu, 0.1, 1.5 * px, null)
    this.fill(target, pts, MOUTH_PAIRS, 0.007 * RIG.ppu, 0.2, 1.5 * px, null)
    this.flush(this.white, BLACK)
    // The felt, and the tongue on it: where the bottom lip cuts the tongue it has the felt's edge, elsewhere its
    // own soft one.
    this.fill(target, pts, MOUTH_PAIRS, 0, 1, px, this.swatch('Felt Black'))
    const tongue = Math.max(0, Math.min(1, (mouth.open - 0.22) / 0.15))
    if (tongue > 0) {
      const { pts: tongueAt, cut } = tonguePoints(mouth, 0, 0)
      const oval = tongueAt.map(([x, y]): Pt => [x + shift, y])
      cut.forEach((c, i) => (this.edge[i] = c ? 0 : tongue))
      this.fill(target, oval, TONGUE_PAIRS, 0, tongue, px, this.swatch('Felt Tongue'), this.edge)
    }
    this.flush(this.atlas!)
    // The felt's cut edge catches a little light: a thin band along it.
    const w = 0.003 * RIG.ppu
    this.normals(pts, w)
    const put = (x: number, y: number) => this.vertex(target, target.m, x, y, 0.5, 0.5, 0.12)
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length
      const [x0, y0] = pts[i]
      const [x1, y1] = pts[j]
      const { nx, ny } = this
      put(x0 - nx[i], y0 - ny[i])
      put(x1 - nx[j], y1 - ny[j])
      put(x0 + nx[i], y0 + ny[i])
      put(x0 + nx[i], y0 + ny[i])
      put(x1 - nx[j], y1 - ny[j])
      put(x1 + nx[j], y1 + ny[j])
    }
    this.flush(this.white)
  }

  /** Roo's front at rest: the fur, felt cheeks (a touch fuller when Roo's pleased), stitched eyes (open, happy
   *  or asleep) and brows, then the mouth. */
  private compose() {
    const p = this.pose
    const t = this.now / 1000
    // Starry eyes twinkle, heart eyes beat, a drop of sweat trembles.
    const twinkle = 1 + 0.07 * Math.sin(TAU * 3 * t)
    const beat = 1 + 0.1 * Math.max(0, Math.sin(TAU * 1.3 * t)) ** 6
    const tremble = 0.006 * RIG.ppu * Math.sin(TAU * 2 * t)
    const moving = p.star > 0.01 || p.heart > 0.01 || p.sweat > 0.01 ? Math.round(this.now / 16) : 0
    const key = [p.eyesOpen * Math.max(0.06, p.blink), p.happy, p.sleep, p.star, p.heart, p.squint, p.wink, p.wide, p.brows, p.browTilt, p.cheeks, p.blush, p.sweat, p.mouthShift, moving, ...p.gaze, ...Object.values(p.mouth)]
      .map((v) => v.toFixed(3))
      .join(' ')
    if (key === this.faceKey) return
    this.faceKey = key
    const face = this.facePicture!
    this.bind(face)
    const target = this.into(face)
    this.piece(target, 'body')
    // Felt cheeks, a touch fuller when Roo's pleased, with /// stitched over them when it blushes.
    const puff = 0.92 + 0.08 * p.cheeks
    const blush = Math.min(1, p.blush * 1.3)
    for (const side of ['L', 'R'] as const) {
      this.facePiece(target, `Cheek.${side}`, 1 - blush, (m) => scaled(m, puff, puff))
      this.facePiece(target, `Blush.${side}`, blush, (m) => scaled(m, puff, puff))
    }
    const [lx, ly] = [p.gaze[0] * 0.016 * RIG.ppu, -p.gaze[1] * 0.012 * RIG.ppu]
    // Each eye is one stitched shape at a time, the last fading as the next comes (and a blink hides it).
    const shape = (key: string, amount: number, pulse = 1) => {
      const k = (0.7 + 0.3 * amount) * pulse
      this.facePiece(target, key, Math.min(1, amount * 1.4), (m) => scaled(m, k, k))
    }
    for (const side of ['L', 'R'] as const) {
      const wink = side === 'R' ? p.wink : 0
      const openY = Math.max(0.04, p.eyesOpen * (1 - wink) * Math.max(0.06, p.blink)) * p.wide
      if (openY > 0.05) this.facePiece(target, `Eye Open.${side}`, 1, (m) => scaled(moved(m, lx, ly), p.wide, openY))
      shape(`Eye Happy.${side}`, Math.max(p.happy, wink))
      shape(`Eye Sleep.${side}`, p.sleep)
      shape(`Eye Star.${side}`, p.star, twinkle)
      shape(`Eye Heart.${side}`, p.heart, beat)
      shape(`Eye Squint.${side}`, p.squint)
      this.facePiece(target, `Brow.${side}`, Math.min(1, p.brows * 1.4), (m) => turned(m, (side === 'R' ? -1 : 1) * p.browTilt))
    }
    this.facePiece(target, 'Sweat', Math.min(1, p.sweat * 1.3), (m) => moved(m, 0, tremble))
    this.flush(this.atlas!)
    this.drawMouth(target)
  }

  /** The body with its face, turned to where Roo looks. */
  private drawBody(target: Target, m: Mat) {
    const gl = this.gl
    const prog = this.warp
    const rect = PIECES.body.rect
    if (this.using.prog !== prog) {
      gl.useProgram(prog.program)
      this.using.prog = prog
    }
    const { axis, angle } = turnAxis(this.pose.yaw, this.pose.pitch)
    gl.uniform3fv(prog.uniforms.uAxis, axis)
    gl.uniform1f(prog.uniforms.uAngle, angle)
    // Its texture coordinates are master-render pixels: the shader works out where to look from them.
    this.quad(target, m, rect, rect, null)
    this.flush(this.facePicture!.tex, WHITE, prog)
  }

  private draw() {
    const gl = this.gl
    if (gl.isContextLost()) return
    if (!this.img || !this.sheet || !this.facePicture) {
      this.bind(null)
      return
    }
    const p = this.pose
    this.compose()

    this.bind(null)
    const { width: W, height: H } = this.canvas
    // Master-render pixels to canvas pixels, the framing's middle at the middle of Roo's box.
    const frame = FRAMES[this.opts.framing]
    const scale = this.ppu() / RIG.ppu
    const [mx, my] = project([0, 0, frame.middle])
    const screen: Target = { w: W, h: H, m: [scale, 0, 0, scale, W / 2 - mx * scale, (H * (HEADROOM + 0.5)) / (1 + HEADROOM) - my * scale] }
    const [gx, gy] = project([0, 0, RIG.body.ground])
    const [cx, cy] = project([0, 0, 0])

    // The contact shadow stays on the ground, smaller and fainter while Roo is in the air.
    const lift = Math.min(0.35, (p.hopY + p.bob) * 0.8)
    const shadow = PIECES.shadow.rect
    this.piece(
      screen,
      'shadow',
      about(IDENTITY, shadow[0] + shadow[2] / 2, gy, (m) => scaled(m, 1 - lift, 1 - lift)),
      1 - Math.min(0.5, p.hopY),
    )

    // Roo: up in the hop, squashed or stretched from its feet, breathing, nearer when it leans in, and tilted
    // and swaying with its mood.
    let body = moved(IDENTITY, 0, -(p.hopY + p.bob) * RIG.ppu)
    body = about(body, gx, gy, (m) => scaled(m, p.zoom / Math.sqrt(p.squash), p.zoom * p.squash * p.breath))
    body = about(body, cx, cy, (m) => turned(m, p.roll - p.tilt))

    // Behind the body, whose fuzzy edge covers where they join: the sprout, swaying about the top of the head,
    // and the arms; all carried round as the body turns.
    const sprout = PIECES.sprout
    const [sx, sy] = sprout.pivot!
    const [tx, ty] = this.carried(sprout.anchor!, p.yaw, p.pitch)
    this.piece(
      screen,
      'sprout',
      about(moved(body, tx, ty), sx, sy, (m) => turned(scaled(m, Math.cos(p.yaw), Math.cos(p.pitch)), -p.leaf)),
    )
    this.arm(screen, body, 'L', p.armL)
    this.arm(screen, body, 'R', p.armR)
    this.flush(this.atlas!)

    this.drawBody(screen, body)

    // The feet stand in front, turning on the spot with the body (they stay on the ground as it nods).
    const feet = PIECES.feet
    if (feet) {
      const [fx, fy] = feet.pivot!
      const [dx] = this.carried(feet.anchor!, p.yaw, 0)
      this.piece(screen, 'feet', about(moved(body, dx, 0), fx, fy, (m) => scaled(m, Math.cos(p.yaw), 1)))
    }

    // The felt emotes float in front, where they were let go.
    for (const e of this.emotes) {
      const at = emoteNow(e, this.now)
      const piece = PIECES[e.key]
      if (!at || !piece) continue
      const [x, y, w, h] = piece.rect
      const [ex, ey] = project([at.x, 0, at.z])
      this.piece(screen, e.key, moved(turned(scaled(moved(IDENTITY, ex, ey), at.size, at.size), at.angle), -(x + w / 2), -(y + h / 2)), at.alpha)
    }
    this.flush(this.atlas!)
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.raf = 0
    window.removeEventListener('pointermove', this.onPointer)
    window.removeEventListener('pointerdown', this.onPointer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.canvas.removeEventListener('webglcontextlost', this.onLost)
    this.observers.forEach((o) => o.disconnect())
    this.img = null
    // Give the GPU memory back now: a page can only keep so many WebGL canvases.
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas.remove()
  }
}
