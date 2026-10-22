import 'maplibre-gl/dist/maplibre-gl.css'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { LocateFixed, Navigation, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MODE_META } from '@/components/icons'
import { MapUnavailable } from '@/components/LazyMap'
import { useOnline } from '@/lib/hooks'
import type { LngLat, MapLine } from '@/lib/geo'
import type { Fix } from '@/lib/location'
import { useResolvedTheme } from '@/lib/theme'

export interface MapPoint {
  id: string
  lngLat: LngLat
  kind: 'stand' | 'stop' | 'user'
  label: string
  number?: number
  onClick?: () => void
  /** A stop drawn as a pin with this icon (and its name under it on the full map). */
  icon?: LucideIcon
  caption?: string
  /** Where the stop sits in the day: done stops fade, the next one pulses. */
  state?: 'done' | 'current' | 'next' | 'later'
}

interface MapCardProps {
  lines: MapLine[]
  points: MapPoint[]
  focus?: LngLat[]
  label: string
  className?: string
  draw?: boolean
  onMapClick?: (lngLat: LngLat) => void
  /** The traveller's live position: a blue dot with its heading and accuracy, and a "Follow me" button. */
  me?: Fix | null
  /** A small preview: no controls, no panning, just the route and the dot. */
  compact?: boolean
  /** Floats over the map while riding: distance and time left, and when they'll arrive. */
  eta?: { primary: string; secondary: string } | null
}

maplibregl.setWorkerUrl(workerUrl)

// A colourful street map by day (parks, water, 3D buildings); a calm dark map by night.
const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
}

// The moving "ants" along the active leg: dash patterns stepped every 60 ms (MapLibre's line animation).
const FLOW: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
]

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function modeColor(mode: MapLine['mode']) {
  const tone = MODE_META[mode].tone
  return token(tone === 'blue' ? '--blue' : tone === 'green' ? '--green' : '--ink')
}

/** Keep the base map lively but let the route lead: fewer shop icons, and 3D buildings in both themes. */
function tune(map: MLMap, theme: 'light' | 'dark', compact: boolean) {
  for (const layer of map.getStyle().layers ?? []) {
    try {
      if (layer.type === 'symbol' && /^poi_r(7|20)$/.test(layer.id)) map.setLayoutProperty(layer.id, 'visibility', 'none')
      if (compact && layer.type === 'symbol' && /poi|transit/.test(layer.id)) map.setLayoutProperty(layer.id, 'visibility', 'none')
    } catch {
      /* some layers reject a property; skip them */
    }
  }
  if (theme === 'dark' && !map.getLayer('building-3d')) {
    const sourceId = Object.keys(map.getStyle().sources ?? {})[0]
    const firstLabel = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id
    try {
      map.addLayer(
        {
          id: 'building-3d',
          type: 'fill-extrusion',
          source: sourceId,
          'source-layer': 'building',
          minzoom: 14,
          paint: {
            'fill-extrusion-color': '#2b3444',
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
            'fill-extrusion-opacity': 0.85,
          },
        },
        firstLabel,
      )
    } catch {
      /* the style has no building layer: flat it is */
    }
  }
}

type RouteData = Parameters<GeoJSONSource['setData']>[0]

function toFC(lines: MapLine[], progress = 1): RouteData {
  const total = lines.reduce((n, l) => n + l.coords.length, 0)
  let budget = Math.max(2, Math.round(total * progress))
  return {
    type: 'FeatureCollection' as const,
    features: lines.flatMap((l) => {
      if (budget < 2) return []
      const take = Math.min(l.coords.length, budget)
      budget -= take
      return [
        {
          type: 'Feature' as const,
          properties: { color: modeColor(l.mode), walk: l.mode === 'walk' ? 1 : 0, dim: l.dim ? 1 : 0, active: l.active ? 1 : 0 },
          geometry: { type: 'LineString' as const, coordinates: l.coords.slice(0, take) },
        },
      ]
    }),
  } as RouteData
}

/** A circle of `radius` metres around a point, for the location's accuracy. */
function circle(center: LngLat, radius: number): RouteData {
  const ring: LngLat[] = []
  const dLat = radius / 111_320
  const dLng = dLat / Math.cos((center[1] * Math.PI) / 180)
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * 2 * Math.PI
    ring.push([center[0] + dLng * Math.cos(a), center[1] + dLat * Math.sin(a)])
  }
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } } as RouteData
}

function bounds(pts: LngLat[]) {
  const b = new maplibregl.LngLatBounds(pts[0], pts[0])
  pts.forEach((p) => b.extend(p))
  return b
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** A stop as a pin: its icon in a coloured head, a pointed tail, and its name beneath (full map). The icon is
 * rendered into the `data-pin-icon` slot through a portal, so it is the same lucide icon as everywhere else. */
function pinNode(p: MapPoint, compact: boolean) {
  const node = document.createElement('div')
  node.className = 'flex flex-col items-center'
  const tone = p.state === 'done' ? 'bg-muted text-on-ink' : p.state === 'next' ? 'bg-green text-on-green' : p.state === 'current' ? 'bg-yellow text-on-yellow' : 'bg-ink text-on-ink'
  const size = compact ? 'size-7' : 'size-10'
  const fade = p.state === 'done' ? 'opacity-70' : ''
  node.innerHTML = `
    <div class="relative flex ${size} items-center justify-center rounded-full border-[3px] border-surface ${tone} shadow-lg ${fade}"><span data-pin-icon class="flex"></span></div>
    <div class="-mt-1.5 size-2.5 rotate-45 ${tone} ${fade}"></div>
    ${!compact && p.caption ? `<span class="mt-1 max-w-36 truncate rounded-full bg-surface px-2 py-0.5 text-[13px] font-bold leading-5 text-ink shadow">${esc(p.caption)}</span>` : ''}`
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', p.label)
  return node
}

export default function MapCard(props: MapCardProps) {
  const online = useOnline()
  const theme = useResolvedTheme()
  if (!online) return <MapUnavailable className={props.className} />
  return <MapInner key={theme} {...props} theme={theme} />
}

function MapInner({ lines, points, focus, label, className = 'h-64', draw, onMapClick, me, compact, eta, theme }: MapCardProps & { theme: 'light' | 'dark' }) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const meMarker = useRef<maplibregl.Marker | null>(null)
  const meArrow = useRef<HTMLElement | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [following, setFollowing] = useState(false)
  const [pins, setPins] = useState<{ key: string; host: HTMLElement; Icon: LucideIcon }[]>([])
  const clickRef = useRef(onMapClick)
  clickRef.current = onMapClick
  // Markers read the latest points (and their click handlers) from here, so they're rebuilt only when the points change.
  const pointsRef = useRef(points)
  pointsRef.current = points
  // What to fit: the focus (the active leg), else every line and point. Read when the map loads or resizes.
  const fitRef = useRef<LngLat[]>([])
  fitRef.current = focus?.length ? focus : [...lines.flatMap((l) => l.coords), ...points.map((p) => p.lngLat)]
  // Once the traveller pans or zooms, the map stops refitting itself.
  const touched = useRef(false)
  const frame = useRef(0)
  const flowFrame = useRef(0)
  // The latest lines, for callbacks set up once with the map (its load and reveal), which would otherwise
  // draw the lines of the first render over newer ones (road shapes that arrive during the reveal).
  const linesRef = useRef(lines)
  linesRef.current = lines
  // Restarts the flow along the active leg when it can run again (see the map's load handler).
  const kickFlow = useRef<() => void>(() => {})
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const padding = compact ? 32 : { top: 72, bottom: 64, left: 56, right: 56 }

  useEffect(() => {
    if (!el.current) return
    const pts = fitRef.current
    const map = new maplibregl.Map({
      container: el.current,
      style: STYLES[theme],
      bounds: pts.length ? bounds(pts) : undefined,
      fitBoundsOptions: { padding, maxZoom: 16 },
      center: pts.length ? undefined : [77.5946, 12.9716],
      zoom: pts.length ? undefined : 11,
      // The mini map is a picture with nothing to focus inside it; it credits the map below instead.
      attributionControl: compact ? false : { compact: true },
      interactive: !compact,
      cooperativeGestures: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxPitch: 60,
    })
    mapRef.current = map
    if (!compact) {
      map.touchZoomRotate.disableRotation()
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    }
    const refit = () => {
      if (touched.current || !fitRef.current.length) return
      map.fitBounds(bounds(fitRef.current), { padding, maxZoom: 16, duration: 0 })
    }
    // The map is often created while its panel is still laying out (or hidden), which fitted the route
    // to a tiny box and showed half the state. Fit again whenever the box changes size.
    const resize = new ResizeObserver(() => {
      map.resize()
      refit()
    })
    resize.observe(el.current)
    let onScreen = true
    const seen = new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting
      kickFlow.current()
    })
    seen.observe(el.current)
    const onVisibility = () => kickFlow.current()
    document.addEventListener('visibilitychange', onVisibility)
    const timeout = setTimeout(() => !map.loaded() && setFailed(true), 12000)
    map.on('error', (e: { error?: { message?: string } }) => {
      if (String(e.error?.message ?? '').includes('style')) setFailed(true)
    })
    map.on('click', (e: { lngLat: { lng: number; lat: number } }) => clickRef.current?.([e.lngLat.lng, e.lngLat.lat]))
    const byHand = (e: { originalEvent?: unknown }) => {
      if (!e.originalEvent) return
      touched.current = true
      setFollowing(false)
    }
    map.on('dragstart', byHand)
    map.on('zoomstart', byHand)
    map.on('load', () => {
      clearTimeout(timeout)
      tune(map, theme, !!compact)
      const surface = token('--surface')
      map.addSource('me-accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: 'me-accuracy', type: 'fill', source: 'me-accuracy', paint: { 'fill-color': token('--blue'), 'fill-opacity': 0.14 } })
      map.addSource('route', { type: 'geojson', data: toFC(linesRef.current, draw && !reduce ? 0 : 1) })
      // A soft glow under the route, a crisp casing, the coloured line, then the flow on the active leg.
      map.addLayer({
        id: 'route-glow',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'dim'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': compact ? 10 : 18, 'line-opacity': 0.18, 'line-blur': compact ? 4 : 8 },
      })
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': surface, 'line-width': compact ? 8 : 11 } })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'walk'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': compact ? 5 : 7, 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] },
      })
      map.addLayer({
        id: 'route-walk',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'walk'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': compact ? 4 : 5, 'line-dasharray': [0.2, 1.6], 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] },
      })
      map.addLayer({
        id: 'route-flow',
        type: 'line',
        source: 'route',
        filter: ['all', ['==', ['get', 'active'], 1], ['==', ['get', 'walk'], 0]],
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: { 'line-color': surface, 'line-width': compact ? 2 : 3, 'line-opacity': 0.9, 'line-dasharray': FLOW[0] },
      })
      if (!reduce) {
        // The flow runs only while it can be seen: a map with an active leg, on screen, in a visible page.
        // Otherwise it stops (no frame is asked for) and starts again when that changes.
        let step = 0
        const running = () => onScreen && !document.hidden && linesRef.current.some((l) => l.active)
        const animate = (t: number) => {
          if (!running()) {
            flowFrame.current = 0
            return
          }
          const next = Math.floor(t / 60) % FLOW.length
          if (next !== step && map.getLayer('route-flow')) {
            step = next
            map.setPaintProperty('route-flow', 'line-dasharray', FLOW[step])
          }
          flowFrame.current = requestAnimationFrame(animate)
        }
        kickFlow.current = () => {
          if (!flowFrame.current && running()) flowFrame.current = requestAnimationFrame(animate)
        }
        kickFlow.current()
      }
      map.resize()
      refit()
      setReady(true)
      if (draw && !reduce) {
        const t0 = performance.now()
        const step = (t: number) => {
          const p = Math.min(1, (t - t0) / 700)
          ;(map.getSource('route') as GeoJSONSource | undefined)?.setData(toFC(linesRef.current, 1 - Math.pow(1 - p, 3)))
          if (p < 1) frame.current = requestAnimationFrame(step)
        }
        frame.current = requestAnimationFrame(step)
      }
    })
    return () => {
      clearTimeout(timeout)
      resize.disconnect()
      seen.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      kickFlow.current = () => {}
      cancelAnimationFrame(frame.current)
      cancelAnimationFrame(flowFrame.current)
      flowFrame.current = 0
      markers.current.forEach((m) => m.remove())
      meMarker.current?.remove()
      meMarker.current = null
      map.remove()
      mapRef.current = null
    }
    // The map is created once per theme; lines, points, focus and the live dot update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lines
  useEffect(() => {
    const src = mapRef.current?.getSource('route') as GeoJSONSource | undefined
    if (ready && src) src.setData(toFC(lines))
    kickFlow.current()
  }, [lines, ready])

  // Markers: stops as icon pins, stands as rings, the traveller (by check-ins) as a yellow "now" dot.
  // A new array with the same points (every render of the parent) keeps the markers; only a change rebuilds them.
  const pointsKey = points.map((p) => `${p.id}:${p.lngLat.join(',')}:${p.kind}:${p.number ?? ''}:${p.label}:${p.state ?? ''}:${p.icon?.displayName ?? ''}:${p.onClick ? 1 : 0}`).join('|')
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markers.current.forEach((m) => m.remove())
    const pins: { key: string; host: HTMLElement; Icon: LucideIcon }[] = []
    markers.current = points.map((p) => {
      if (p.kind === 'stop' && p.icon) {
        const node = pinNode(p, !!compact)
        const host = node.querySelector<HTMLElement>('[data-pin-icon]')
        if (host) pins.push({ key: p.id, host, Icon: p.icon })
        // The pin's tail tip sits on the place.
        return new maplibregl.Marker({ element: node, anchor: 'top', offset: [0, compact ? -32 : -48] }).setLngLat(p.lngLat).addTo(map)
      }
      const size = p.number ? 'size-8' : p.kind === 'user' ? 'size-5' : compact ? 'size-3' : 'size-4'
      const look =
        p.kind === 'user'
          ? 'bg-yellow border-ink'
          : p.number
            ? 'bg-green border-surface text-on-green t-caption'
            : p.kind === 'stop'
              ? 'bg-surface border-ink'
              : 'bg-surface border-green'
      const dot = document.createElement('span')
      dot.className = `flex ${size} items-center justify-center rounded-full ${compact ? 'border-2' : 'border-[3px]'} ${look}`
      if (p.number) dot.textContent = String(p.number)
      let node: HTMLElement = dot
      if (p.onClick && !compact) {
        // A 48 px transparent button around the ring, so the stand is easy to hit with a thumb.
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'flex size-12 items-center justify-center rounded-full outline-offset-2'
        button.setAttribute('aria-label', p.label)
        dot.setAttribute('aria-hidden', 'true')
        button.appendChild(dot)
        button.addEventListener('click', (e) => {
          e.stopPropagation()
          pointsRef.current.find((x) => x.id === p.id)?.onClick?.()
        })
        node = button
      } else {
        dot.setAttribute('role', 'img')
        dot.setAttribute('aria-label', p.label)
      }
      return new maplibregl.Marker({ element: node }).setLngLat(p.lngLat).addTo(map)
    })
    setPins(pins)
    // pointsKey stands for the points by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey, ready])

  // The live blue dot with its heading, its accuracy circle, and following it in a tilted, 3D view.
  const meLngLat: LngLat | null = me ? [me.lng, me.lat] : null
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const acc = map.getSource('me-accuracy') as GeoJSONSource | undefined
    if (!meLngLat || !me) {
      meMarker.current?.remove()
      meMarker.current = null
      acc?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    if (!meMarker.current) {
      const node = document.createElement('span')
      node.className = 'relative flex size-12 items-center justify-center'
      node.setAttribute('role', 'img')
      node.setAttribute('aria-label', 'You are here, by your phone’s location')
      node.innerHTML = `
        <span data-arrow class="absolute inset-0 transition-transform duration-500" style="opacity:0">
          <span class="absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 border-x-[9px] border-b-[16px] border-x-transparent border-b-blue opacity-80"></span>
        </span>
        ${reduce ? '' : '<span class="absolute inset-2.5 animate-ping rounded-full bg-blue opacity-30"></span>'}
        <span class="relative size-5 rounded-full border-[3px] border-surface bg-blue shadow-lg"></span>`
      meArrow.current = node.querySelector('[data-arrow]')
      meMarker.current = new maplibregl.Marker({ element: node }).setLngLat(meLngLat).addTo(map)
    } else meMarker.current.setLngLat(meLngLat)
    if (meArrow.current) {
      const heading = me.heading
      const known = heading != null && !Number.isNaN(heading)
      meArrow.current.style.opacity = known ? '1' : '0'
      if (known) meArrow.current.style.transform = `rotate(${heading}deg)`
    }
    acc?.setData(circle(meLngLat, Math.min(me.accuracy, 500)))
    if (following) map.easeTo({ center: meLngLat, zoom: Math.max(map.getZoom(), 16), pitch: compact ? 0 : 55, duration: reduce ? 0 : 900 })
    // The dot moves when the fix does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.lng, me?.lat, me?.accuracy, me?.heading, ready, following])

  // Leaving follow mode settles the camera back flat.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || following) return
    if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: reduce ? 0 : 600 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, ready])

  // Fly to the active leg (800 ms, in-out) when it changes.
  const focusKey = JSON.stringify(focus)
  const first = useRef(true)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus?.length) return
    if (first.current) {
      first.current = false
      return
    }
    if (following) return
    touched.current = false
    map.fitBounds(bounds(focus), { padding, maxZoom: 16, duration: reduce ? 0 : 800, easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  return (
    <div className={`relative overflow-hidden rounded-card border border-line bg-sunken ${className}`}>
      {/* MapLibre's stylesheet sets .maplibregl-map { position: relative } on the element it
          mounts into, which would cancel `absolute inset-0` there and collapse it to 0 px. The
          wrapper does the positioning; the map fills it. */}
      <div className="absolute inset-0">
        <div ref={el} className="h-full w-full" aria-label={compact ? undefined : label} role={compact ? undefined : 'region'} aria-hidden={compact || undefined} />
      </div>
      {pins.map(({ key, host, Icon }) => createPortal(<Icon size={compact ? 14 : 20} strokeWidth={2} aria-hidden="true" />, host, key))}
      {eta && !compact && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 shadow-[var(--shadow-toast)]">
          <Navigation size={20} strokeWidth={1.75} aria-hidden="true" className="text-blue" />
          <div>
            <p className="t-title text-ink tnum">{eta.primary}</p>
            <p className="t-small text-ink-2 tnum">{eta.secondary}</p>
          </div>
        </div>
      )}
      {compact && (
        <span aria-hidden="true" className="absolute bottom-1 right-1.5 rounded bg-surface/90 px-1.5 text-[11px] leading-5 text-ink-2">
          © OpenStreetMap, OpenFreeMap
        </span>
      )}
      {me && !compact && ready && (
        <button
          type="button"
          onClick={() => {
            touched.current = true
            setFollowing((f) => !f)
          }}
          aria-pressed={following}
          className={`absolute bottom-3 left-3 z-10 inline-flex min-h-12 items-center gap-2 rounded-full border px-4 t-small font-bold shadow-sm ${
            following ? 'border-blue bg-blue-tint text-ink' : 'border-line bg-surface text-ink [@media(hover:hover)]:hover:bg-sunken'
          }`}
        >
          <LocateFixed size={18} strokeWidth={1.75} aria-hidden="true" />
          {following ? 'Following you' : 'Follow me'}
        </button>
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col justify-center bg-surface p-5">
          <p className="t-title text-ink">The map didn't load</p>
          <p className="mt-1 t-small text-ink-2">Follow the written directions. They have everything you need.</p>
        </div>
      )}
    </div>
  )
}
