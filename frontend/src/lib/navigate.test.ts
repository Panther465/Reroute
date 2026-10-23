import { describe, expect, it } from 'vitest'
import type { LegPath, PathSegment, PathStep } from '@/api/types'
import type { LngLat } from './geo'
import { googleMapsUrl, travelMode } from './gmaps'
import { course, follow, START } from './navigate'
import { legCoords, pathLines } from './paths'
import { instruction, legSummary } from './turns'

const step = (s: Partial<PathStep> & Pick<PathStep, 'kind'>): PathStep => ({ modifier: '', name: '', exit: null, distanceM: 0, durationS: 0, at: 0, line: null, towards: null, stops: null, ...s })
const seg = (s: Partial<PathSegment> & Pick<PathSegment, 'mode' | 'source' | 'coords'>): PathSegment => ({ stops: [], line: null, distanceM: 0, durationS: 0, steps: [], ...s })

// Hotel, walk 120 m east then turn left to the station; two stops on the Purple Line; then a stretch with no road known.
const HOTEL: LngLat = [77.5713, 12.9767]
const CORNER: LngLat = [77.5724, 12.9767]
const MAJESTIC: LngLat = [77.5728, 12.9757]
const LEG: LegPath = {
  seq: 1,
  complete: true,
  segments: [
    seg({
      mode: 'walk',
      source: 'road',
      coords: [HOTEL, CORNER, MAJESTIC],
      distanceM: 240,
      steps: [step({ kind: 'depart', name: 'Gubbi Thotadappa Road', at: 0 }), step({ kind: 'turn', modifier: 'left', name: 'Tank Bund Road', at: 1 }), step({ kind: 'arrive', at: 2 })],
    }),
    seg({
      mode: 'metro',
      source: 'rail',
      coords: [MAJESTIC, [77.585, 12.976], [77.597, 12.9765]],
      distanceM: 2600,
      line: { name: 'Purple Line', colour: '#8e2a8f' },
      stops: [
        { name: 'Majestic', lng: MAJESTIC[0], lat: MAJESTIC[1] },
        { name: 'Sir M. Visvesvaraya', lng: 77.585, lat: 12.976 },
        { name: 'Vidhana Soudha', lng: 77.597, lat: 12.9765 },
      ],
      steps: [step({ kind: 'board', name: 'Majestic', line: 'Purple Line', towards: 'Whitefield (Kadugodi)', stops: 2, at: 0 }), step({ kind: 'alight', name: 'Vidhana Soudha', at: 2 })],
    }),
    seg({ mode: 'walk', source: 'approximate', coords: [[77.597, 12.9765], [77.599, 12.979]], distanceM: 340 }),
  ],
}

describe('turns', () => {
  const road = LEG.segments[0]
  it('says each manoeuvre plainly, naming the road when there is one', () => {
    expect(instruction(step({ kind: 'turn', modifier: 'left' }), road, 'the meeting').text).toBe('Turn left')
    expect(instruction(step({ kind: 'turn', modifier: 'sharp right', name: 'MG Road' }), road, '').text).toBe('Turn sharp right onto MG Road')
    expect(instruction(step({ kind: 'continue', modifier: 'slight right', name: 'Hosur Road' }), road, '').text).toBe('Bear right onto Hosur Road')
    expect(instruction(step({ kind: 'roundabout', exit: 2, name: 'Residency Road' }), road, '')).toEqual({ text: 'At the roundabout, take the 2nd exit onto Residency Road', icon: 'roundabout' })
    expect(instruction(step({ kind: 'end of road', modifier: 'right' }), road, '').text).toBe('At the end of the road, turn right')
    expect(instruction(step({ kind: 'arrive' }), road, 'the meeting').text).toBe('Arrive at the meeting')
  })

  it('sums a leg up a stretch at a time', () => {
    expect(legSummary(LEG, 'the meeting')).toEqual([
      'Walk 240 m to Majestic.',
      'Take the Purple Line from Majestic towards Whitefield (Kadugodi), 2 stops, and get off at Vidhana Soudha.',
      'Make your way to the meeting, about 340 m. There are no street directions for this stretch.',
    ])
  })
})

describe('navigate', () => {
  const c = course(LEG, 'the meeting')

  it('lists the leg’s instructions in order, without the joins between stretches', () => {
    expect(c.steps.map((s) => s.text)).toEqual([
      'Head off along Gubbi Thotadappa Road',
      'Turn left onto Tank Bund Road',
      'Take the Purple Line from Majestic towards Whitefield (Kadugodi), 2 stops',
      'Get off at Vidhana Soudha',
      'Make your way to the meeting, about 340 m. There are no street directions for this stretch.',
    ])
    expect(c.steps.map((s) => s.atM)).toEqual([...c.steps.map((s) => s.atM)].sort((a, b) => a - b))
    expect(c.walking).toBe(false)
  })

  it('follows the traveller to the next turn, and calls it off route only twice running', () => {
    const start = follow(c, START, { lng: HOTEL[0], lat: HOTEL[1], accuracy: 10 })!
    expect(c.steps[start.next].text).toBe('Turn left onto Tank Bund Road')
    expect(start.toNextM).toBeGreaterThan(100)
    expect(start.toNextM).toBeLessThan(130)
    // Round the corner: the metro is next.
    const turned = follow(c, start.tracker, { lng: 77.5726, lat: 12.9762, accuracy: 10 }, start)!
    expect(c.steps[turned.next].text).toMatch(/^Take the Purple Line/)
    // 300 m off the line: once is a poor fix, twice is off route.
    const away = { lng: 77.5726, lat: 12.9735, accuracy: 15 }
    const once = follow(c, turned.tracker, away, turned)!
    expect(once.tracker.offRoute).toBe(false)
    expect(follow(c, once.tracker, away, once)!.tracker.offRoute).toBe(true)
    // A fix too rough to place changes nothing.
    expect(follow(c, turned.tracker, { lng: 77.6, lat: 12.9, accuracy: 250 }, turned)).toBe(turned)
  })
})

describe('Google Maps', () => {
  it('opens the leg with latitude first, in the right travel mode', () => {
    const url = new URL(googleMapsUrl([77.5713, 12.9767], [77.7318, 12.9855], 'transit', true))
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/')
    expect(Object.fromEntries(url.searchParams)).toEqual({ api: '1', origin: '12.9767,77.5713', destination: '12.9855,77.7318', travelmode: 'transit', dir_action: 'navigate' })
    expect(googleMapsUrl([1, 2], [3, 4], 'walking')).not.toContain('dir_action')
    expect([travelMode(['metro', 'shared_auto']), travelMode(['walk']), travelMode(['shared_auto']), travelMode(['cab'])]).toEqual(['transit', 'walking', 'driving', 'driving'])
  })
})

describe('paths', () => {
  it('draws a leg as its stretches, straight and dashed where no road is known', () => {
    const lines = pathLines({ seq: 1, fromPlaceId: 'a', toPlaceId: 'b', segments: [] }, LEG, new Map())
    expect(lines.map((l) => [l.mode, !!l.approximate, l.color])).toEqual([
      ['walk', false, undefined],
      ['metro', false, '#8e2a8f'],
      ['walk', true, undefined],
    ])
    // Not drawn yet: one straight line, marked approximate, never a made-up curve.
    const places = new Map<string, LngLat>([
      ['a', HOTEL],
      ['b', MAJESTIC],
    ])
    expect(pathLines({ seq: 2, fromPlaceId: 'a', toPlaceId: 'b', segments: [{ mode: 'cab', minutes: 9 }] }, undefined, places)).toEqual([
      { id: '2-0', coords: [HOTEL, MAJESTIC], mode: 'cab', dim: false, approximate: true },
    ])
    // The whole leg as one line, each joint once.
    expect(legCoords(LEG)).toHaveLength(3 + 2 + 1)
  })
})
