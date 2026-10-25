// Google's map under the app's maps, when the server has a Google Maps key (GET /v1/maps/tiles): its tiles as the
// map's style, and where the copyright line Google gives for what's on screen comes from. Without a key (or once
// Google's session has ended) the maps stay OpenStreetMap's.
import type { StyleSpecification } from 'maplibre-gl'
import type { MapTiles } from '@/api/types'

/** A Google map the app can draw: the server's answer, while its tiles' session lasts. */
export function googleTiles(tiles: MapTiles | undefined, now = Date.now()): MapTiles | null {
  if (!tiles || tiles.provider !== 'google' || !tiles.tilesUrl) return null
  if (tiles.expiresAt && Date.parse(tiles.expiresAt) <= now) return null
  return tiles
}

/** Google refusing its map's tiles: the key's quota used up, the Map Tiles API switched off, or the session ended. A
 *  map seeing a few of these goes back to OpenStreetMap's rather than staying blank under the routes. */
export function refusedByGoogle(e: { sourceId?: string; error?: { status?: number } }): boolean {
  return e.sourceId === 'google' && [400, 401, 403, 429].includes(e.error?.status ?? 0)
}

/** Tiles Google refuses before a map gives up on Google's and draws OpenStreetMap's. */
export const REFUSALS_BEFORE_FREE_MAP = 3

/** Google's roadmap as the map's style: one layer of 256 px tiles (at twice the pixels); its night colours in dark mode. */
export function googleStyle(tiles: MapTiles, theme: 'light' | 'dark'): StyleSpecification {
  const url = (theme === 'dark' && tiles.darkTilesUrl) || tiles.tilesUrl || ''
  return {
    version: 8,
    sources: { google: { type: 'raster', tiles: [url], tileSize: 256, maxzoom: 22 } },
    layers: [{ id: 'google', type: 'raster', source: 'google' }],
  }
}

const round = (n: number) => String(Math.round(n * 1e6) / 1e6)
/** Into -180 … 180, as Google's viewport request wants a longitude. */
const lng = (x: number) => Math.min(179.999999, Math.max(-179.999999, ((((x + 180) % 360) + 360) % 360) - 180))
const lat = (y: number) => Math.min(89.999999, Math.max(-89.999999, y))

/** A view as Google's copyright line sees it: its whole zoom and its edges to about a kilometre. A map following the
 *  traveller moves every second; it asks again only once the view is really another one. */
export function viewKey(zoom: number, view: { north: number; south: number; east: number; west: number }): string {
  return [Math.round(zoom), view.north, view.south, view.east, view.west].map((n, i) => (i === 0 ? String(n) : n.toFixed(2))).join(':')
}

/** Where Google's copyright line for a view comes from: the view's zoom and edges added to the server's address. */
export function viewportUrl(tiles: MapTiles, theme: 'light' | 'dark', zoom: number, view: { north: number; south: number; east: number; west: number }): string | null {
  const base = (theme === 'dark' && tiles.darkViewportUrl) || tiles.viewportUrl
  if (!base) return null
  const q = new URLSearchParams({
    zoom: String(Math.max(0, Math.min(22, Math.round(zoom)))),
    north: round(lat(view.north)),
    south: round(lat(view.south)),
    east: round(lng(view.east)),
    west: round(lng(view.west)),
  })
  return `${base}&${q.toString()}`
}
