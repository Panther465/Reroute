// Whether this device shows Roo in 3D. Not with reduced motion, Save-Data, a low-end phone, or a GPU the
// browser calls slow (software rendering): there the flat Roo stays, and three.js is never downloaded.
// `localStorage['reroute.roo3d']` = 'on' or 'off' overrides it, for testing.

let known: boolean | null = null

function webgl(strict: boolean): boolean {
  try {
    const canvas = document.createElement('canvas')
    const attrs = { failIfMajorPerformanceCaveat: strict }
    const gl = (canvas.getContext('webgl2', attrs) ?? canvas.getContext('webgl', attrs)) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

export function roo3dSupported(): boolean {
  if (known !== null) return known
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  let override: string | null = null
  try {
    override = localStorage.getItem('reroute.roo3d')
  } catch {
    /* storage blocked */
  }
  if (override === 'off') return (known = false)
  if (override === 'on') return (known = webgl(false))
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return (known = false)
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number }
  if (nav.connection?.saveData) return (known = false)
  if ((nav.hardwareConcurrency ?? 4) <= 2 || (nav.deviceMemory ?? 4) <= 1) return (known = false)
  return (known = webgl(true))
}

/** The 3D Roo lost its drawing context: flat Roo for the rest of the visit. */
export function roo3dFailed() {
  known = false
}
