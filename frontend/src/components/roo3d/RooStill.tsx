import type { Mood } from '@/components/roo/mood'
import { stillPlace, type Framing } from './frame'

// Roo's stills: the 3D Roo standing still in each mood, drawn by its engine (roo3d/stills.mjs), small and large.
const FILES = import.meta.glob<string>('./stills/*.webp', { eager: true, import: 'default' })

/** A mood's still, small and large. */
export function stillOf(mood: Mood): { small: string; large: string } {
  return { small: FILES[`./stills/roo-${mood}-192.webp`], large: FILES[`./stills/roo-${mood}-640.webp`] }
}

/**
 * The 3D Roo's still, in a Roo box `size` wide (and a tenth taller), exactly where the live Roo stands in that box
 * (the still can reach out of the box a little, as the live Roo's canvas does). Decorative.
 */
export function StillPicture({ mood, size, framing = 'full', className = '' }: { mood: Mood; size: number; framing?: Framing; className?: string }) {
  const { left, top, side } = stillPlace(size, Math.round(size * 1.1), framing)
  const { small, large } = stillOf(mood)
  return (
    <img
      src={small}
      srcSet={`${small} 192w, ${large} 640w`}
      sizes={`${Math.ceil(side)}px`}
      alt=""
      draggable={false}
      decoding="async"
      className={`pointer-events-none absolute max-w-none select-none ${className}`}
      style={{ left, top, width: side, height: side }}
    />
  )
}

/** Roo as its still, where a live 3D Roo isn't wanted: beside each of its lines in the chat. */
export function RooStill({ mood, size, framing }: { mood: Mood; size: number; framing?: Framing }) {
  return (
    <span className="relative inline-block align-bottom" style={{ width: size, height: Math.round(size * 1.1) }} aria-hidden="true">
      <StillPicture mood={mood} size={size} framing={framing} />
    </span>
  )
}
