import 'maplibre-gl/dist/maplibre-gl.css'
import * as maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MLMap } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { MODE_META } from '@/components/icons'
import { useOnline } from '@/lib/hooks'
import type { LngLat, MapLine } from '@/lib/geo'
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

function MapInner({ lines, points, focus, label, className = 'h-64', draw, onMapClick, theme }: MapCardProps & { theme: 'light' | 'dark' }) {
  const el = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MLMap | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const clickRef = useRef(onMapClick)
  clickRef.current = onMapClick
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    if (!el.current) return
    const pts = focus?.length ? focus : points.map((p) => p.lngLat)
    const map = new maplibregl.Map({
      container: el.current,
      style: STYLES[theme],
      bounds: pts.length ? bounds(pts) : undefined,
      fitBoundsOptions: { padding: 48 },
      center: pts.length ? undefined : [77.5946, 12.9716],
      zoom: pts.length ? undefined : 11,
      attributionControl: { compact: true },
      cooperativeGestures: false,
      dragRotate: false,
      pitchWithRotate: false,
    })
    mapRef.current = map
    map.touchZoomRotate.disableRotation()
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    const timeout = setTimeout(() => !map.loaded() && setFailed(true), 12000)
    map.on('error', (e: { error?: { message?: string } }) => {
      if (String(e.error?.message ?? '').includes('style')) setFailed(true)
    })
    map.on('click', (e: { lngLat: { lng: number; lat: number } }) => clickRef.current?.([e.lngLat.lng, e.lngLat.lat]))
    map.on('load', () => {
      clearTimeout(timeout)
      mute(map)
      map.addSource('route', { type: 'geojson', data: toFC(lines, draw && !reduce ? 0 : 1) })
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': token('--surface'), 'line-width': 10 } })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'walk'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': ['case', ['==', ['get', 'dim'], 1], 0.35, 1] },
      })
      map.addLayer({
        id: 'route-walk',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'walk'], 1],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-dasharray': [0.2, 1.6] },
      })
      setReady(true)
      if (draw && !reduce) {
        const t0 = performance.now()
        const step = (t: number) => {
          const p = Math.min(1, (t - t0) / 600)
          ;(map.getSource('route') as GeoJSONSource | undefined)?.setData(toFC(lines, 1 - Math.pow(1 - p, 3)))
          if (p < 1) requestAnimationFrame(step)
        }
        requestAnimationFrame(step)
      }
    })
    return () => {
      clearTimeout(timeout)
      markers.current.forEach((m) => m.remove())
      map.remove()
      mapRef.current = null
    }
    // The map is created once per theme; lines, points and focus update below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lines
  useEffect(() => {
    const src = mapRef.current?.getSource('route') as GeoJSONSource | undefined
    if (ready && src) src.setData(toFC(lines))
  }, [lines, ready])

  // Markers: stands and stops as rings, the traveller as a yellow "now" dot.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markers.current.forEach((m) => m.remove())
    markers.current = points.map((p) => {
      const size = p.number ? 'size-8' : p.kind === 'user' ? 'size-5' : 'size-4'
      const look =
        p.kind === 'user'
          ? 'bg-yellow border-ink'
          : p.number
            ? 'bg-green border-surface text-on-green t-caption'
            : p.kind === 'stop'
              ? 'bg-surface border-ink'
              : 'bg-surface border-green'
      const dot = document.createElement('span')
      dot.className = `flex ${size} items-center justify-center rounded-full border-[3px] ${look}`
      if (p.number) dot.textContent = String(p.number)
      let node: HTMLElement = dot
      if (p.onClick) {
        // A 48 px transparent button around the ring, so the stand is easy to hit with a thumb.
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'flex size-12 items-center justify-center rounded-full outline-offset-2'
        button.setAttribute('aria-label', p.label)
        dot.setAttribute('aria-hidden', 'true')
        button.appendChild(dot)
        button.addEventListener('click', (e) => {
          e.stopPropagation()
          p.onClick!()
        })
        node = button
      } else {
        dot.setAttribute('role', 'img')
        dot.setAttribute('aria-label', p.label)
      }
      return new maplibregl.Marker({ element: node }).setLngLat(p.lngLat).addTo(map)
    })
  }, [points, ready])

  // Fly to the active leg (800 ms, in-out).
  const focusKey = JSON.stringify(focus)
  const first = useRef(true)
  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus?.length) return
    if (first.current) {
      first.current = false
      return
    }
    map.fitBounds(bounds(focus), { padding: 56, duration: reduce ? 0 : 800, easing: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey])

  return (
    <div className={`relative overflow-hidden rounded-card border border-line bg-sunken ${className}`}>
      <div ref={el} className="absolute inset-0" aria-label={label} role="region" />
      {failed && (
        <div className="absolute inset-0 flex flex-col justify-center bg-surface p-5">
          <p className="t-title text-ink">The map didn't load</p>
          <p className="mt-1 t-small text-ink-2">Follow the written directions. They have everything you need.</p>
        </div>
      )}
    </div>
  )
}
