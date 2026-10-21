import 'maplibre-gl/dist/maplibre-gl.css'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { LocateFixed, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MODE_META } from '@/components/icons'
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
}

interface MapCardProps {
  lines: MapLine[]
  points: MapPoint[]
  focus?: LngLat[]
  label: string
  className?: string
  draw?: boolean
  onMapClick?: (lngLat: LngLat) => void
  /** The traveller's live position: a blue dot with its accuracy, and a "Follow me" button. */
  me?: Fix | null
  /** A small preview: no controls, no panning, just the route and the dot. */
  compact?: boolean
}

maplibregl.setWorkerUrl(workerUrl)

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
}

function token(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function modeColor(mode: MapLine['mode']) {
  const tone = MODE_META[mode].tone
  return token(tone === 'blue' ? '--blue' : tone === 'green' ? '--green' : '--ink')
}

/** Mute the base style using our tokens so the route lines carry the colour. */
function mute(map: MLMap) {
  const ground = token('--ground')
  const sunken = token('--surface-sunken')
  const line = token('--line')
  const surface = token('--surface')
  const muted = token('--muted')
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id
    try {
      if (layer.type === 'background') map.setPaintProperty(id, 'background-color', ground)
      else if (layer.type === 'fill' && /water/.test(id)) map.setPaintProperty(id, 'fill-color', line)
      else if (layer.type === 'fill' && /park|landuse|landcover|wood|grass/.test(id)) map.setPaintProperty(id, 'fill-color', sunken)
      else if (layer.type === 'fill' && /building/.test(id)) map.setPaintProperty(id, 'fill-color', sunken)
      else if (layer.type === 'line' && /road|highway|street|bridge|tunnel/.test(id)) map.setPaintProperty(id, 'line-color', surface)
      else if (layer.type === 'line' && /water|river/.test(id)) map.setPaintProperty(id, 'line-color', line)
      else if (layer.type === 'symbol') {
        map.setPaintProperty(id, 'text-color', muted)
        map.setPaintProperty(id, 'text-halo-color', ground)
        if (/poi/.test(id)) map.setLayoutProperty(id, 'visibility', 'none')
      }
    } catch {
      /* some layers reject a property; skip them */
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
      return [{ type: 'Feature' as const, properties: { color: modeColor(l.mode), walk: l.mode === 'walk' ? 1 : 0, dim: l.dim ? 1 : 0 }, geometry: { type: 'LineString' as const, coordinates: l.coords.slice(0, take) } }]
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

export default function MapCard(props: MapCardProps) {
  const online = useOnline()
  const theme = useResolvedTheme()
  if (!online) {
    return (
      <div className={`flex flex-col justify-center rounded-card border border-line bg-surface p-5 ${props.className ?? 'h-64'}`}>
        <WifiOff size={24} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
        <p className="mt-3 t-title text-ink">The map needs a connection</p>
        <p className="mt-1 t-small text-ink-2">The written directions still work offline.</p>
      </div>
    )
  }
  return <MapInner key={theme} {...props} theme={theme} />
}

function MapInner({ lines, points, focus, label, className = 'h-64', draw, onMapClick, me, compact, theme }: MapCardProps & { theme: 'light' | 'dark' }) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const meMarker = useRef<maplibregl.Marker | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [following, setFollowing] = useState(false)
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
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const padding = compact ? 28 : 56

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
      mute(map)
      map.addSource('me-accuracy', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({ id: 'me-accuracy', type: 'fill', source: 'me-accuracy', paint: { 'fill-color': token('--blue'), 'fill-opacity': 0.12 } })
      map.addSource('route', { type: 'geojson', data: toFC(lines, draw && !reduce ? 0 : 1) })
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': token('--surface'), 'line-width': compact ? 7 : 10 } })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'walk'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': compact ? 4 : 6, 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] },
      })
      map.addLayer({
        id: 'route-walk',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'walk'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': compact ? 3.5 : 5, 'line-dasharray': [0.2, 1.6], 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] },
      })
      map.resize()
      refit()
      setReady(true)
      if (draw && !reduce) {
        const t0 = performance.now()
        const step = (t: number) => {
          const p = Math.min(1, (t - t0) / 600)
          ;(map.getSource('route') as GeoJSONSource | undefined)?.setData(toFC(lines, 1 - Math.pow(1 - p, 3)))
          if (p < 1) frame.current = requestAnimationFrame(step)
        }
        frame.current = requestAnimationFrame(step)
      }
    })
    return () => {
      clearTimeout(timeout)
      resize.disconnect()
      cancelAnimationFrame(frame.current)
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
  }, [lines, ready])

  // Markers: stands and stops as rings, the traveller (by check-ins) as a yellow "now" dot. A new array
  // with the same points (every render of the parent) keeps the markers; only a change rebuilds them.
  const pointsKey = points.map((p) => `${p.id}:${p.lngLat.join(',')}:${p.kind}:${p.number ?? ''}:${p.label}:${p.onClick ? 1 : 0}`).join('|')
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markers.current.forEach((m) => m.remove())
    markers.current = points.map((p) => {
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
    // pointsKey stands for the points by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey, ready])

  // The live blue dot, its accuracy circle, and following it.
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
      node.className = 'relative flex size-6 items-center justify-center'
      node.setAttribute('role', 'img')
      node.setAttribute('aria-label', 'You are here, by your phone’s location')
      node.innerHTML = `${reduce ? '' : '<span class="absolute inset-0 animate-ping rounded-full bg-blue opacity-40"></span>'}<span class="relative size-4 rounded-full border-[3px] border-surface bg-blue shadow"></span>`
      meMarker.current = new maplibregl.Marker({ element: node }).setLngLat(meLngLat).addTo(map)
    } else meMarker.current.setLngLat(meLngLat)
    acc?.setData(circle(meLngLat, Math.min(me.accuracy, 500)))
    if (following) map.easeTo({ center: meLngLat, zoom: Math.max(map.getZoom(), 15), duration: reduce ? 0 : 600 })
    // The dot moves when the fix does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.lng, me?.lat, me?.accuracy, ready, following])

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
      {compact && (
        <span aria-hidden="true" className="absolute bottom-1 right-1.5 rounded bg-surface/90 px-1.5 text-[11px] leading-5 text-ink-2">
          © OpenStreetMap · OpenFreeMap
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
          className={`absolute bottom-3 left-3 z-10 inline-flex min-h-11 items-center gap-2 rounded-full border px-4 t-small font-bold shadow-sm ${
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
