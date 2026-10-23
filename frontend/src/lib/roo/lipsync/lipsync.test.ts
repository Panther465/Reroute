import { describe, expect, it } from 'vitest'
import { mouthOutline, mouthPathD, REST } from './mouth'
import { buildTrack, estimateWords, sampleTrack } from './timeline'
import { spellNumber, wordToVisemes } from './visemes'

const shapes = (w: string) => wordToVisemes(w).map((s) => s.v)

describe('mouth shapes from spelling', () => {
  it('closes the lips on b, m and p, rounds on o and oo, widens on ee', () => {
    expect(shapes('map')).toEqual(['MBP', 'AI', 'MBP'])
    expect(shapes('bank')).toEqual(['MBP', 'AI', 'E'])
    expect(shapes('two')).toEqual(['E', 'U', 'O'])
    expect(shapes('Roo')).toEqual(['O', 'U'])
    expect(shapes('meet')).toEqual(['MBP', 'E'])
    expect(shapes('phone')).toEqual(['FV', 'O', 'E'])
  })

  it('skips letters a word doesn’t say, and says numbers', () => {
    expect(shapes('time')).toEqual(['E', 'MBP'])
    expect(shapes('know')).toEqual(['E', 'O'])
    expect(shapes('the')).toEqual(['L'])
    expect(spellNumber('45')).toBe('forty five')
    expect(spellNumber('10')).toBe('ten')
    expect(shapes('10')).toEqual(shapes('ten'))
  })

  it('gives words in another script an even rhythm', () => {
    expect(wordToVisemes('नमस्ते').length).toBeGreaterThan(1)
  })
})

describe('a line’s track', () => {
  const words = [
    { text: 'Time', offsetMs: 50, durationMs: 210 },
    { text: 'to', offsetMs: 270, durationMs: 90 },
    { text: 'leave,', offsetMs: 370, durationMs: 260 },
    { text: 'Arjun', offsetMs: 900, durationMs: 330 },
  ]
  const track = buildTrack(words, 0)

  it('keeps each word’s shapes inside the word, and closes the mouth in a pause', () => {
    for (const w of words) {
      const inside = track.filter((k) => k.t >= w.offsetMs - 1 && k.t < w.offsetMs + w.durationMs)
      expect(inside.length).toBeGreaterThan(0)
    }
    const pause = track.find((k) => k.v === 'rest' && k.t > 600 && k.t < 700)
    expect(pause).toBeTruthy()
    expect(sampleTrack(track, 750)).toEqual(REST)
  })

  it('holds b, m and p shut long enough to be seen', () => {
    for (const k of track.filter((k) => k.v === 'MBP')) expect(k.end - k.t).toBeGreaterThanOrEqual(60)
    const shut = track.find((k) => k.v === 'MBP')!
    // Shut within a few frames, and for the rest of the sound.
    expect(sampleTrack(track, shut.t + 30).open).toBe(0)
    expect(sampleTrack(track, shut.end - 1).open).toBe(0)
  })

  it('opens wider when the voice is louder, and only half as much when murmuring', () => {
    const vowel = track.find((k) => k.v === 'AI' || k.v === 'E')!
    const at = vowel.t + 80
    expect(sampleTrack(track, at, 1).open).toBeGreaterThan(sampleTrack(track, at, 0.2).open)
    expect(sampleTrack(track, at, 1, 0.5).open).toBeCloseTo(sampleTrack(track, at, 1).open / 2, 5)
  })

  it('moves smoothly: no jump bigger than a blend allows in one frame', () => {
    let prev = sampleTrack(track, 0)
    for (let t = 0; t < 1400; t += 16) {
      const p = sampleTrack(track, t)
      expect(Math.abs(p.open - prev.open)).toBeLessThan(0.75)
      prev = p
    }
  })

  it('is shut before the line and after it', () => {
    expect(sampleTrack(track, -100)).toEqual(REST)
    expect(sampleTrack(track, 5000)).toEqual(REST)
  })
})

describe('estimated timing, for a voice that doesn’t say', () => {
  it('spreads the words over the time, longer words longer, with a pause after a comma', () => {
    const words = estimateWords('Okay, leave at nine.', 2000)
    expect(words.map((w) => w.text)).toEqual(['Okay,', 'leave', 'at', 'nine.'])
    expect(words[1].durationMs).toBeGreaterThan(words[2].durationMs)
    expect(words[1].offsetMs - (words[0].offsetMs + words[0].durationMs)).toBeGreaterThan(50)
    const last = words[words.length - 1]
    expect(last.offsetMs + last.durationMs).toBeLessThanOrEqual(2000)
  })
})

describe('the outline', () => {
  it('is a closed shape whose opening grows with `open`', () => {
    const shut = mouthOutline(REST)
    const open = mouthOutline({ ...REST, open: 0.9 })
    const height = (pts: [number, number][]) => Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))
    expect(height(open)).toBeGreaterThan(height(shut) * 3)
    expect(mouthPathD(REST)).toMatch(/^M[\d.]+ [\d.]+ Q.* Z$/)
  })
})
