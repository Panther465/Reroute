import { describe, expect, it } from 'vitest'
import { goldenTrip, places } from '@/test/fixtures'
import { placeIndex } from './geo'
import { activeLeg, legGuide } from './guide'
import type { Fix } from './location'
import { metres, progressAlong, splitPath } from './progress'
import { buildDay } from './timeline'

const fix = (lng: number, lat: number): Fix => ({ lng, lat, accuracy: 10, heading: null, speed: null, at: 0 })

describe('progress along a road path', () => {
  const path: [number, number][] = [
    [77.6, 12.93],
    [77.61, 12.93],
    [77.61, 12.94],
  ]
  it('measures what is left from the nearest point on the path', () => {
    const p = progressAlong(path, [77.605, 12.9301])!
    expect(p.segment).toBe(0)
    expect(p.offRouteM).toBeLessThan(20)
    const expected = metres([77.605, 12.93], [77.61, 12.93]) + metres([77.61, 12.93], [77.61, 12.94])
    expect(Math.abs(p.remainingM - expected)).toBeLessThan(15)
    const { behind, ahead } = splitPath(path, p)
    expect(behind[0]).toEqual(path[0])
    expect(ahead[ahead.length - 1]).toEqual(path[2])
  })
})

describe('the leg that matters now', () => {
  it('is the leg into a stop while riding to it, before the task starts', () => {
    const view = buildDay(goldenTrip('09:20'))!
    expect(activeLeg(view, 9 * 60 + 20, null)).toMatchObject({ leg: { toId: 'task-meet' }, riding: true })
  })

  it('is the next leg while still at a task, riding only once the traveller says they left', () => {
    const view = buildDay(goldenTrip('10:55'))!
    expect(activeLeg(view, 655, null)).toMatchObject({ leg: { toId: 'task-bank' }, riding: false })
    expect(activeLeg(view, 655, 'task-bank')).toMatchObject({ riding: true })
  })
})

describe('nearly there and arrived', () => {
  const trip = goldenTrip('09:20')
  const view = buildDay(trip)!
  const index = placeIndex(trip)
  const guide = (f: Fix | null) => legGuide(view, 9 * 60 + 20, null, index, new Map(), f)!

  it('says nothing without a location', () => {
    expect(guide(null)).toMatchObject({ riding: true, near: false, arrived: false, remainingM: null })
  })
  it('is near within 800 m and arrived within 120 m of the stop', () => {
    const office = places.wf
    expect(guide(fix(office.lng - 0.005, office.lat))).toMatchObject({ near: true, arrived: false })
    expect(guide(fix(office.lng - 0.0005, office.lat))).toMatchObject({ near: true, arrived: true })
    const far = guide(fix(places.hotel.lng, places.hotel.lat))
    expect(far.near).toBe(false)
    expect(far.etaMin).toBeGreaterThan(30)
  })
})
