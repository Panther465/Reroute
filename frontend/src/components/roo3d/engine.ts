// Roo in 3D: the same green sprout as the flat drawing, built from simple shapes (no model files) as a soft
// plush toy, with fur, and moved with springs. Its mouth follows the voice: each frame it takes the
// shape lib/speech/channel.ts says Roo is making. It draws only while it's on screen.

import * as THREE from 'three'
import type { Mood } from '@/components/roo/RooArt'
import { mix, mouthOutline, mouthSize, REST, type MouthParams } from '@/lib/roo/lipsync/mouth'
import { mouthNow } from '@/lib/speech/channel'

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

function palette() {
  const css = getComputedStyle(document.documentElement)
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    body: get('--roo-body', '#2fa36a'),
    deep: get('--roo-deep', '#11683f'),
    leaf: get('--roo-leaf', '#62cf93'),
    ink: get('--roo-ink', '#142019'),
    blush: get('--roo-blush', '#ff8fa3'),
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

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
  idle: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0, mouth: REST, cheeks: 0.55 },
  happy: { eyesOpen: 0, happy: 1, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0.06, mouth: { open: 0.55, wide: 0.45, round: 0, smile: 1 }, cheeks: 0.85 },
  wave: { eyesOpen: 0, happy: 1, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0.05, leaf: 0.08, mouth: { open: 0.55, wide: 0.45, round: 0, smile: 1 }, cheeks: 0.85 },
  celebrate: { eyesOpen: 0, happy: 1, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0.12, mouth: { open: 0.75, wide: 0.5, round: 0, smile: 1 }, cheeks: 0.95 },
  thinking: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1, brows: 1, browTilt: -0.25, look: [-0.7, 0.75], tilt: -0.08, leaf: -0.22, mouth: { open: 0, wide: -0.15, round: 0, smile: 0 }, cheeks: 0.45 },
  listening: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1.12, brows: 0, browTilt: 0, look: [0, 0], tilt: 0.1, leaf: 0.14, mouth: { open: 0.05, wide: 0, round: 0, smile: 0.5 }, cheeks: 0.6 },
  talking: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0, leaf: 0.04, mouth: REST, cheeks: 0.6 },
  alert: { eyesOpen: 1, happy: 0, sleep: 0, wide: 1.14, brows: 1, browTilt: 0.3, look: [0, 0], tilt: 0, leaf: 0.18, mouth: { open: 0.35, wide: -0.4, round: 1, smile: 0 }, cheeks: 0.5 },
  sleeping: { eyesOpen: 0, happy: 0, sleep: 1, wide: 1, brows: 0, browTilt: 0, look: null, tilt: 0.06, leaf: -0.1, mouth: { open: 0, wide: -0.3, round: 0, smile: 0.2 }, cheeks: 0.45 },
}

// ---------- the model ----------

const MOUTH_POINTS = 32
/** Flat-drawing units to body radii: the drawing's body is 29 across from centre to side. */
const UNIT = 1 / 29

interface Model {
  root: THREE.Group
  body: THREE.Group
  sprout: THREE.Group
  arms: THREE.Group[]
  eyes: { open: THREE.Group; pupil: THREE.Group; happy: THREE.Mesh; sleep: THREE.Mesh; brow: THREE.Mesh; side: number }[]
  cheeks: THREE.Mesh[]
  mouth: THREE.Mesh
  tongue: THREE.Mesh
  shadow: THREE.Mesh
  materials: Record<'ink' | 'bead' | 'cheek' | 'mouth' | 'tongue', THREE.Material>
  fur: Fur
}

function bodyGeometry(color: string): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 64, 48)
  geo.scale(1, 0.95, 0.88)
  // A lighter belly, front and low, painted into the vertices so it blends without a seam.
  const base = new THREE.Color(color)
  const light = base.clone().lerp(new THREE.Color('#ffffff'), 0.2)
  const n = geo.getAttribute('normal')
  const colors = new Float32Array(n.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < n.count; i++) {
    const w = smooth(0.25, 0.85, n.getZ(i)) * smooth(0.25, -0.55, n.getY(i))
    c.copy(base).lerp(light, w)
    colors.set([c.r, c.g, c.b], i * 3)
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  return geo
}

/** A stuffed fabric leaf: a flattened pillow about 0.56 long, pointed at both ends and cupped a little. */
function leafGeometry(): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 28, 18)
  const p = geo.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i)
    const y = p.getY(i)
    const z = p.getZ(i)
    // The sphere's axis becomes the leaf's length: the base at one pole, the tip at the other.
    const t = (y + 1) / 2
    const taper = Math.pow(Math.max(0, 1 - y * y), 0.25)
    const across = x * 0.115 * taper
    p.setXYZ(i, 0.56 * t, 0.06 * t + 0.03 * Math.sin(Math.PI * t) + across, z * 0.04 * taper + 0.3 * across * across)
  }
  geo.computeVertexNormals()
  return geo
}

function shadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(0,0,0,0.32)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

/** A soft-edged disc, for the felt cheeks. */
function feltEdge(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 20, 32, 32, 32)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(1, '#000000')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return new THREE.CanvasTexture(c)
}

// ---------- fur ----------

/** Shared by every layer of fur, so one change moves all of it. */
interface Fur {
  /** How the fur lags behind Roo's movement. */
  sway: { value: THREE.Vector3 }
  /** Strands per body radius, set from the canvas size so a strand is about 2 pixels across. */
  density: { value: number }
}

interface FurOpts {
  layers: number
  /** How far the tips reach, in body radii. */
  length: number
  vertexColors?: boolean
}

const FUR_VERTEX_HEAD = `
uniform float uLayer;
uniform float uLength;
uniform vec3 uSway;
varying vec3 vFurPos;
varying vec3 vFurNormal;`

// Each layer sits a little further out, droops a little more, and lags when Roo moves.
const FUR_VERTEX = `
vFurPos = position;
vFurNormal = normal;
transformed += normal * uLength * uLayer + (vec3(0.0, -0.35, 0.0) + uSway) * uLength * uLayer * uLayer;`

// Strands without a texture or UVs: space is cut into tiny cubes, each holding one strand at a random spot with
// a random length, thickness and shade, so there are no seams and no bunching at the top of the head. The cubes
// are turned at an odd angle, so their rows never line up with the screen's pixels where Roo faces you. A layer
// keeps the strands long enough to reach it, thinner towards the tips; deeper layers are darker, like real pile.
const FUR_FRAGMENT_HEAD = `
uniform float uLayer;
uniform float uDensity;
varying vec3 vFurPos;
varying vec3 vFurNormal;
const mat3 FUR_TURN = mat3(0.6486, 0.6821, -0.3376, -0.5740, 0.7297, 0.3715, 0.4998, -0.0472, 0.8649);
vec3 furHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}`

const FUR_FRAGMENT = `
vec3 furQ = FUR_TURN * vFurPos * uDensity;
vec3 furId = floor(furQ);
vec3 furH = furHash(furId);
vec3 furD = furQ - furId - 0.5 - (furH - 0.5) * 0.36;
vec3 furN = normalize(FUR_TURN * vFurNormal);
furD -= furN * dot(furD, furN);
if (0.3 + 0.7 * furH.x < uLayer || length(furD) > (0.5 - 0.38 * uLayer) * (0.7 + 0.3 * furH.y)) discard;
diffuseColor.rgb *= mix(0.8, 1.05, uLayer) * (0.94 + 0.12 * furH.z);`

const WHITE = new THREE.Color('#ffffff')

/** Plush fabric: fully matte, with the soft sheen velvet has where it turns away from you. */
function plushMaterial(color: THREE.Color, vertexColors: boolean, tint: THREE.Color): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({ color, vertexColors, roughness: 1, metalness: 0, sheen: 0.85, sheenRoughness: 0.5, sheenColor: tint })
}

/**
 * A plush part: the shape itself (the backing, a little darker) and its fur, drawn as shells: the same shape
 * again and again, each layer a little further out (see the shaders above).
 */
function plush(geo: THREE.BufferGeometry, color: THREE.Color, o: FurOpts, fur: Fur): THREE.Group {
  const g = new THREE.Group()
  const base = o.vertexColors ? WHITE : color
  const tint = color.clone().lerp(WHITE, 0.35)
  g.add(new THREE.Mesh(geo, plushMaterial(base.clone().multiplyScalar(0.74), !!o.vertexColors, tint)))
  for (let i = 1; i <= o.layers; i++) {
    const layer = i / o.layers
    const mat = plushMaterial(base, !!o.vertexColors, tint)
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, { uLayer: { value: layer }, uLength: { value: o.length }, uSway: fur.sway, uDensity: fur.density })
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>${FUR_VERTEX_HEAD}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>${FUR_VERTEX}`)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>${FUR_FRAGMENT_HEAD}`)
        .replace('#include <color_fragment>', `#include <color_fragment>${FUR_FRAGMENT}`)
    }
    // Every layer shares one compiled program; only the uniforms differ.
    mat.customProgramCacheKey = () => 'roo-fur'
    g.add(new THREE.Mesh(geo, mat))
  }
  return g
}

function build(scene: THREE.Scene, quiet: boolean): Model {
  const pal = palette()
  // A small Roo can't show single strands: fewer layers draw the same soft edge for less work.
  const L = (n: number) => (quiet ? Math.max(5, Math.round(n / 3)) : n)
  const fur: Fur = { sway: { value: new THREE.Vector3() }, density: { value: 50 } }
  const green = new THREE.Color(pal.body)
  // Embroidered thread and felt, matte; the open eyes are glossy beads, like a plush toy's. The face is stitched
  // on top of the fur, so it's drawn after it (renderOrder) and never sinks into it.
  const stitched = { depthTest: false, depthWrite: false }
  const materials = {
    ink: new THREE.MeshStandardMaterial({ color: pal.ink, roughness: 0.85, ...stitched }),
    bead: new THREE.MeshPhysicalMaterial({ color: pal.ink, roughness: 0.15, clearcoat: 1, ...stitched }),
    cheek: new THREE.MeshStandardMaterial({ color: pal.blush, roughness: 1, transparent: true, alphaMap: feltEdge(), ...stitched }),
    mouth: new THREE.MeshStandardMaterial({ color: pal.ink, roughness: 0.9, side: THREE.DoubleSide, ...stitched }),
    tongue: new THREE.MeshStandardMaterial({ color: pal.blush, roughness: 1, side: THREE.DoubleSide, ...stitched }),
  }

  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)
  scene.add(root)
  body.add(plush(bodyGeometry(pal.body), green, { layers: L(22), length: 0.065, vertexColors: true }, fur))

  // Feet stay on the ground while the body breathes.
  const footGeo = new THREE.SphereGeometry(0.27, 32, 20)
  for (const side of [-1, 1]) {
    const foot = plush(footGeo, green, { layers: L(12), length: 0.05 }, fur)
    foot.scale.set(1, 0.6, 1.15)
    foot.position.set(side * 0.3, -0.9, 0.12)
    root.add(foot)
  }

  // Arms hang from a shoulder pivot, so they can wave.
  const armGeo = new THREE.CapsuleGeometry(0.16, 0.28, 8, 20)
  const arms = [-1, 1].map((side) => {
    const pivot = new THREE.Group()
    pivot.position.set(side * 0.86, 0.02, 0.05)
    const arm = plush(armGeo, green, { layers: L(12), length: 0.05 }, fur)
    arm.position.set(side * 0.09, -0.24, 0)
    arm.rotation.z = side * 0.38
    pivot.add(arm)
    body.add(pivot)
    return pivot
  })

  // The sprout pivots at the top of the head, so it sways and droops: a fuzzy stem and two fuzzy leaves.
  const sprout = new THREE.Group()
  sprout.position.set(0, 0.9, 0)
  body.add(sprout)
  const stem = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.04, 0), new THREE.Vector3(-0.012, 0.18, 0.01), new THREE.Vector3(0.025, 0.38, 0)])
  sprout.add(plush(new THREE.TubeGeometry(stem, 16, 0.045, 10), green.clone().lerp(new THREE.Color(pal.deep), 0.35), { layers: L(8), length: 0.022 }, fur))
  const leafGeo = leafGeometry()
  const leafGreen = green.clone().lerp(new THREE.Color(pal.leaf), 0.3)
  const right = plush(leafGeo, leafGreen, { layers: L(10), length: 0.03 }, fur)
  right.position.set(0.03, 0.36, 0)
  right.rotation.set(0.2, 0, 0.32)
  const left = plush(leafGeo, leafGreen, { layers: L(10), length: 0.03 }, fur)
  left.scale.set(-0.86, 0.86, 0.86)
  left.position.set(0.015, 0.31, 0)
  left.rotation.set(0.2, 0, -0.22)
  sprout.add(right, left)

  // The face sits on top of the fur, like embroidery: bead eyes with a catchlight that moves with the gaze,
  // stitched arcs for happy and sleepy, and a stitched brow for thinking and alarm.
  const beadGeo = new THREE.SphereGeometry(0.135, 28, 20)
  const glintGeo = new THREE.SphereGeometry(0.038, 12, 8)
  const arcGeo = new THREE.TorusGeometry(0.12, 0.032, 10, 28, Math.PI)
  const browGeo = new THREE.CapsuleGeometry(0.026, 0.2, 4, 8)
  const glintMat = new THREE.MeshBasicMaterial({ color: '#ffffff', ...stitched })
  const eyes = [-1, 1].map((side) => {
    const eye = new THREE.Group()
    eye.position.set(side * 0.36, 0.2, 0.81)
    eye.rotation.set(-0.16, side * 0.36, 0)
    body.add(eye)
    const open = new THREE.Group()
    eye.add(open)
    const pupil = new THREE.Group()
    const bead = new THREE.Mesh(beadGeo, materials.bead)
    bead.scale.set(1, 1.12, 0.55)
    bead.renderOrder = 1
    const glint = new THREE.Mesh(glintGeo, glintMat)
    glint.position.set(-0.045, 0.055, 0.07)
    glint.renderOrder = 2
    pupil.add(bead, glint)
    open.add(pupil)
    const happy = new THREE.Mesh(arcGeo, materials.ink)
    happy.position.set(0, -0.03, 0.04)
    const sleep = new THREE.Mesh(arcGeo, materials.ink)
    sleep.rotation.z = Math.PI
    sleep.position.set(0, 0.03, 0.04)
    const brow = new THREE.Mesh(browGeo, materials.ink)
    brow.rotation.z = Math.PI / 2
    brow.position.set(0, 0.3, 0.02)
    happy.renderOrder = sleep.renderOrder = brow.renderOrder = 1
    eye.add(happy, sleep, brow)
    return { open, pupil, happy, sleep, brow, side }
  })

  // Felt cheeks, on the fur.
  const cheekGeo = new THREE.CircleGeometry(0.12, 32)
  const cheeks = [-1, 1].map((side) => {
    const cheek = new THREE.Mesh(cheekGeo, materials.cheek)
    cheek.scale.set(1.3, 0.9, 1)
    cheek.position.set(side * 0.62, -0.13, 0.76)
    cheek.rotation.set(0.1, side * 0.66, 0)
    cheek.renderOrder = 1
    body.add(cheek)
    return cheek
  })

  // The mouth: a fan of triangles whose outline is rebuilt from the lip-sync shape every frame Roo talks,
  // bent to sit on the round face, above the fur; a felt tongue shows when it's open wide.
  const fan = new THREE.BufferGeometry()
  fan.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((MOUTH_POINTS + 1) * 3), 3))
  const index: number[] = []
  for (let i = 1; i <= MOUTH_POINTS; i++) index.push(0, i, (i % MOUTH_POINTS) + 1)
  fan.setIndex(index)
  const mouthGroup = new THREE.Group()
  mouthGroup.position.set(0, -0.27, 0.912)
  mouthGroup.rotation.x = 0.33
  body.add(mouthGroup)
  const mouth = new THREE.Mesh(fan, materials.mouth)
  mouth.renderOrder = 1
  const tongue = new THREE.Mesh(new THREE.CircleGeometry(1, 24), materials.tongue)
  tongue.position.z = 0.004
  tongue.renderOrder = 2
  mouthGroup.add(mouth, tongue)

  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.62), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false }))
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = -1.04
  scene.add(shadow)

  return { root, body, sprout, arms, eyes, cheeks, mouth, tongue, shadow, materials, fur }
}

function setMouth(m: Model, p: MouthParams) {
  const pts = mouthOutline(p, MOUTH_POINTS)
  const pos = m.mouth.geometry.getAttribute('position') as THREE.BufferAttribute
  let cx = 0
  let cy = 0
  pts.forEach(([x, y], i) => {
    const px = x * UNIT
    const py = -y * UNIT
    cx += px
    cy += py
    // Hug the round face: the corners sit a little further back than the middle.
    pos.setXYZ(i + 1, px, py, -0.55 * px * px)
  })
  pos.setXYZ(0, cx / pts.length, cy / pts.length, 0)
  pos.needsUpdate = true
  m.mouth.geometry.computeBoundingSphere()
  const { halfWidth, height, dip } = mouthSize(p)
  m.tongue.visible = p.open > 0.3
  m.tongue.scale.set(Math.max(0.001, halfWidth * 0.5 * UNIT), Math.max(0.001, height * 0.2 * UNIT), 1)
  m.tongue.position.set(0, -(dip + 0.5 * height) * UNIT, 0.004 - 0.55 * 0)
}

// ---------- the engine ----------

export class RooEngine {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(24, 1 / 1.1, 0.1, 50)
  private model: Model
  private canvas: HTMLCanvasElement
  private raf = 0
  private last = 0
  private visible = true
  private frameSkip = false
  private readyCalled = false
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
    cheeks: new Spring(0.55, 3.5, 0.85),
    leaf: new Spring(0, 2.6, 0.22),
    armL: new Spring(0, 4, 0.55),
    armR: new Spring(0, 4, 0.55),
    open: new Spring(0, 14, 1),
    wideM: new Spring(0, 9, 1),
    round: new Spring(0, 9, 1),
    smile: new Spring(0.35, 9, 1),
  }

  constructor(
    host: HTMLElement,
    private opts: EngineOptions,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.setAttribute('aria-hidden', 'true')
    this.canvas.style.cssText = 'display:block;width:100%;height:100%;pointer-events:none'
    host.appendChild(this.canvas)
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: 'low-power' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.canvas.addEventListener('webglcontextlost', this.lost)

    // Soft studio light for plush: a broad sky, a warm key from the upper left, and a rim that makes the
    // fur's tips glow at the edges.
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#86a892', 1.5))
    const key = new THREE.DirectionalLight('#fff8ef', 2.1)
    key.position.set(-2.2, 3, 4)
    const fill = new THREE.DirectionalLight('#f3fff6', 0.7)
    fill.position.set(3, 0.4, 3)
    const rim = new THREE.DirectionalLight('#f2fff6', 2.2)
    rim.position.set(2.4, 2.2, -3)
    this.scene.add(key, fill, rim)

    this.model = build(this.scene, !!opts.quiet)
    setMouth(this.model, REST)
    this.frame()
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
    this.start()
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
    if (next.theme && next.theme !== prev.theme) this.recolour()
  }

  private hop(big: boolean) {
    this.hopAt = performance.now()
    this.hopBig = big
  }

  private recolour() {
    const pal = palette()
    const m = this.model.materials
    ;(m.ink as THREE.MeshStandardMaterial).color.set(pal.ink)
    ;(m.bead as THREE.MeshPhysicalMaterial).color.set(pal.ink)
    ;(m.cheek as THREE.MeshStandardMaterial).color.set(pal.blush)
    ;(m.mouth as THREE.MeshStandardMaterial).color.set(pal.ink)
    ;(m.tongue as THREE.MeshStandardMaterial).color.set(pal.blush)
  }

  private frame() {
    if (this.opts.framing === 'portrait') {
      this.camera.position.set(0, 0.42, 6.1)
      this.camera.lookAt(0, 0.36, 0)
    } else {
      this.camera.position.set(0, 0.3, 6.9)
      this.camera.lookAt(0, 0.24, 0)
    }
  }

  private resize() {
    const w = this.canvas.clientWidth || 1
    const h = this.canvas.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    // A strand about 2 pixels across, whatever size Roo is drawn at: fine fuzz, not spikes.
    const unit = (h * this.renderer.getPixelRatio()) / (2 * this.camera.position.z * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))
    this.model.fur.density.value = THREE.MathUtils.clamp(unit / 2.2, 30, 110)
  }

  private onPointer = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect()
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

  private lost = (e: Event) => {
    e.preventDefault()
    this.dispose()
    this.opts.onFail()
  }

  private start() {
    if (this.raf || !this.visible || document.visibilityState !== 'visible') return
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
      this.renderer.render(this.scene, this.camera)
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
    const m = this.model
    const face = FACES[this.state.mood]
    const t = now / 1000

    // Breathing, slow and small.
    const breath = 1 + 0.017 * Math.sin(2 * Math.PI * 0.25 * t)

    // A hop: crouch, spring up stretched, fall, land squashed, wobble. The big one is a celebration.
    let hopTarget = 0
    let squashTarget = 1
    const since = now - this.hopAt
    const hopping = this.hopAt >= 0 && since < 650
    if (hopping) {
      const p = since / 650
      const height = this.hopBig ? 0.42 : 0.2
      if (p < 0.14) squashTarget = 0.9
      else if (p < 0.5) {
        hopTarget = height * Math.sin(((p - 0.14) / 0.72) * Math.PI)
        squashTarget = 1.08
      } else if (p < 0.86) {
        hopTarget = height * Math.sin(((p - 0.14) / 0.72) * Math.PI)
        squashTarget = 1.03
      } else squashTarget = 0.88
    }
    const y = s.hopY.to(hopTarget, dt)
    const sq = s.squash.to(squashTarget, dt)
    m.root.position.y = y
    m.root.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq))
    m.body.scale.set(1, breath, 1)
    m.shadow.scale.setScalar(1 - Math.min(0.35, y * 0.8))
    ;(m.shadow.material as THREE.MeshBasicMaterial).opacity = 1 - Math.min(0.5, y)

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
    const gx = s.gazeX.to(look[0], dt)
    const gy = s.gazeY.to(look[1], dt)
    const hx = s.headX.to(look[0], dt)
    const hy = s.headY.to(look[1], dt)
    const tilt = s.tilt.to(face.tilt, dt)

    // Blinks every few seconds (sometimes twice), and on every change of mood.
    if (now > this.nextBlink) {
      this.blinkAt = now
      this.nextBlink = now + 2200 + Math.random() * 2600 + (Math.random() < 0.12 ? -1800 : 0)
    }
    const b = now - this.blinkAt
    const blink = b < 0 ? 1 : b < 60 ? 1 - b / 60 : b < 100 ? 0 : b < 210 ? (b - 100) / 110 : 1

    const eyesOpen = s.eyesOpen.to(face.eyesOpen, dt)
    const happy = s.happy.to(face.happy, dt)
    const sleep = s.sleep.to(face.sleep, dt)
    const wide = s.wide.to(face.wide, dt)
    const brows = s.brows.to(face.brows, dt)
    const browTilt = s.browTilt.to(face.browTilt, dt)
    for (const e of m.eyes) {
      const openY = Math.max(0.04, eyesOpen * Math.max(0.06, blink)) * wide
      e.open.scale.set(wide, openY, 1)
      e.open.visible = openY > 0.05
      e.pupil.position.x = gx * 0.065
      e.pupil.position.y = gy * 0.055
      e.happy.scale.setScalar(Math.max(0.001, happy))
      e.happy.visible = happy > 0.02
      e.sleep.scale.setScalar(Math.max(0.001, sleep))
      e.sleep.visible = sleep > 0.02
      e.brow.scale.setScalar(Math.max(0.001, brows))
      e.brow.visible = brows > 0.02
      e.brow.rotation.z = Math.PI / 2 + e.side * browTilt
    }
    const cheek = s.cheeks.to(face.cheeks, dt)
    for (const c of m.cheeks) (c.material as THREE.MeshBasicMaterial).opacity = cheek

    // Arms: a wave with the right hand (1.2 s), both up to celebrate, otherwise hanging and swaying.
    const waving = this.waveAt >= 0 && now - this.waveAt < 1200
    const wavePhase = waving ? Math.sin(((now - this.waveAt) / 1000) * 2 * Math.PI * 1.6) : 0
    const celebrating = this.state.mood === 'celebrate'
    const sway = 0.04 * Math.sin(t * 1.3)
    const armR = s.armR.to(celebrating ? 2.3 : waving ? 1.7 + 0.45 * wavePhase : sway, dt)
    const armL = s.armL.to(celebrating ? 2.3 : this.state.mood === 'thinking' ? 0.55 : -sway, dt)
    m.arms[1].rotation.z = armR
    m.arms[0].rotation.z = -armL

    // The fur lags behind too: it streams down as Roo rises and puffs up as it lands.
    this.model.fur.sway.value.set(-s.headX.v * 0.25, Math.max(-1.2, Math.min(1.2, -s.hopY.v * 0.9)), 0)

    // The sprout lags behind the body: follow-through when Roo hops, a droop when it thinks.
    const leaf = s.leaf.to(face.leaf - s.hopY.v * 0.35 + 0.03 * Math.sin(t * 1.7), dt)
    m.sprout.rotation.z = leaf
    m.sprout.rotation.x = -leaf * 0.4

    // The mouth: the voice's shape while Roo talks, else the mood's.
    const said = mouthNow()
    const target = said ?? face.mouth
    const open = s.open.to(target.open, dt)
    const mouth = { open: Math.max(0, open), wide: s.wideM.to(target.wide, dt), round: s.round.to(target.round, dt), smile: s.smile.to(target.smile, dt) }
    setMouth(m, said ? mix(mouth, target, 0.35) : mouth)

    // The head follows the gaze, tilts with the mood, and nods a little on loud words.
    m.body.rotation.y = hx * 0.24
    m.body.rotation.x = -hy * 0.12 + (said ? said.open * 0.035 : 0)
    m.body.rotation.z = tilt

    return !!said || hopping || waving || this.state.mood === 'listening'
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.raf = 0
    window.removeEventListener('pointermove', this.onPointer)
    window.removeEventListener('pointerdown', this.onPointer)
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.canvas.removeEventListener('webglcontextlost', this.lost)
    this.observers.forEach((o) => o.disconnect())
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const mats = Array.isArray(o.material) ? o.material : [o.material]
        mats.forEach((mat) => {
          ;(mat as THREE.MeshBasicMaterial).map?.dispose()
          ;(mat as THREE.MeshBasicMaterial).alphaMap?.dispose()
          mat.dispose()
        })
      }
    })
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.canvas.remove()
  }
}
