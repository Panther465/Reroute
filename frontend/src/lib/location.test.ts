import { describe, expect, it } from 'vitest'
import { glideMs } from './location'

describe('following the traveller on the map', () => {
  it('glides to each fix over the time until the next one, so the arrow and the camera arrive together', () => {
    // The phone's location every second; the demo ride every half second.
    expect(glideMs(1000)).toBe(1000)
    expect(glideMs(500)).toBe(500)
    // Two fixes at once still move; after a long pause it doesn't crawl.
    expect(glideMs(40)).toBe(250)
    expect(glideMs(60_000)).toBe(1500)
    // The first fix is where they are.
    expect(glideMs(null)).toBe(0)
  })
})
