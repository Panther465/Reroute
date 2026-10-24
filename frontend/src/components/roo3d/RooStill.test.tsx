import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MOODS } from '@/components/roo/mood'
import { FRAMES, place, project, stillPlace, STILL_MARGIN } from './frame'
import { RIG } from './rig'
import { RooStill, stillOf } from './RooStill'

describe('where Roo stands in its box', () => {
  it('puts the framing’s middle at the middle of the box, and its height across the box', () => {
    for (const framing of ['full', 'portrait'] as const) {
      const [w, h] = [46, 51]
      const { left, top, side } = place(w, h, framing)
      const at = (z: number) => {
        const [x, y] = project([0, 0, z])
        return [left + (x / RIG.size) * side, top + (y / RIG.size) * side]
      }
      const { middle, height } = FRAMES[framing]
      expect(at(middle)[0]).toBeCloseTo(w / 2, 6)
      expect(at(middle)[1]).toBeCloseTo(h / 2, 6)
      // The camera looks down a touch, so the framing's top and bottom land within a hair of the box's edges.
      expect(at(middle + height / 2)[1]).toBeCloseTo(0, 1)
      expect(at(middle - height / 2)[1]).toBeCloseTo(h, 1)
    }
  })

  it('places a still over the same spot, with its margin all round', () => {
    const live = place(26, 29, 'full')
    const still = stillPlace(26, 29, 'full')
    const margin = live.side * STILL_MARGIN
    expect(still.side).toBeCloseTo(live.side + 2 * margin, 9)
    expect(still.left).toBeCloseTo(live.left - margin, 9)
    expect(still.top).toBeCloseTo(live.top - margin, 9)
  })
})

describe('Roo’s stills', () => {
  it('has the 3D Roo in every mood, small and large', () => {
    for (const mood of MOODS) {
      const { small, large } = stillOf(mood)
      expect(small).toMatch(new RegExp(`roo-${mood}-192.*\\.webp`))
      expect(large).toMatch(new RegExp(`roo-${mood}-640.*\\.webp`))
    }
  })

  it('shows a mood’s still as decoration, sized to where the live Roo would stand', () => {
    const { container } = render(<RooStill mood="thinking" size={26} />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('alt')).toBe('')
    expect(img.getAttribute('src')).toBe(stillOf('thinking').small)
    expect(img.getAttribute('srcset')).toContain(`${stillOf('thinking').large} 640w`)
    const { side } = stillPlace(26, 29, 'full')
    expect(parseFloat(img.style.width)).toBeCloseTo(side, 3)
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
  })
})
