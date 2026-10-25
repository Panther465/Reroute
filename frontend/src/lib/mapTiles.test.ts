import { describe, expect, it } from 'vitest'
import type { MapTiles } from '@/api/types'
import { googleStyle, googleTiles, viewportUrl } from './mapTiles'

const GOOGLE: MapTiles = {
  provider: 'google',
  tilesUrl: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=L&key=K',
  darkTilesUrl: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=D&key=K',
  viewportUrl: 'https://tile.googleapis.com/tile/v1/viewport?session=L&key=K',
  darkViewportUrl: 'https://tile.googleapis.com/tile/v1/viewport?session=D&key=K',
  expiresAt: '2026-11-08T00:00:00Z',
}

describe('Google’s map under the app’s maps', () => {
  it('is drawn while its session lasts, and never without a key', () => {
    const now = Date.parse('2026-10-26T00:00:00Z')
    expect(googleTiles(GOOGLE, now)).toBe(GOOGLE)
    expect(googleTiles(GOOGLE, Date.parse('2026-11-08T00:00:01Z'))).toBeNull()
    expect(googleTiles({ provider: 'open' }, now)).toBeNull()
    expect(googleTiles(undefined, now)).toBeNull()
  })

  it('is Google’s roadmap in light, its night style in dark', () => {
    const light = googleStyle(GOOGLE, 'light')
    expect(light.sources.google).toEqual({ type: 'raster', tiles: [GOOGLE.tilesUrl], tileSize: 256, maxzoom: 22 })
    expect(light.layers).toEqual([{ id: 'google', type: 'raster', source: 'google' }])
    expect(googleStyle(GOOGLE, 'dark').sources.google).toMatchObject({ tiles: [GOOGLE.darkTilesUrl] })
  })

  it('asks Google for the copyright line of the view on screen, its edges kept in range', () => {
    const url = viewportUrl(GOOGLE, 'light', 14.6, { north: 12.99, south: 12.95, east: 77.62, west: 77.58 })
    expect(url).toBe(`${GOOGLE.viewportUrl}&zoom=15&north=12.99&south=12.95&east=77.62&west=77.58`)
    const wide = new URL(viewportUrl(GOOGLE, 'dark', 1, { north: 95, south: -95, east: 190, west: -200 })!)
    expect(wide.searchParams.get('session')).toBe('D')
    expect([wide.searchParams.get('north'), wide.searchParams.get('south')]).toEqual(['89.999999', '-89.999999'])
    expect([wide.searchParams.get('east'), wide.searchParams.get('west')]).toEqual(['-170', '160'])
  })
})
