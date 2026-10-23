import { useEffect, useRef } from 'react'
import type { Mood } from '@/components/roo/RooArt'
import { RooEngine, type Framing } from './engine'

/** The 3D Roo's canvas (a lazy chunk: the rendered Roo loads only where it's shown). Decorative: the button
 *  or dialog around it carries the name. */
export default function Roo3DView({
  mood,
  hop,
  theme,
  framing,
  quiet,
  className,
  onReady,
  onFail,
}: {
  mood: Mood
  hop: number
  theme: 'light' | 'dark'
  framing: Framing
  quiet: boolean
  className?: string
  onReady: () => void
  onFail: () => void
}) {
  const host = useRef<HTMLSpanElement>(null)
  const engine = useRef<RooEngine | null>(null)
  const props = useRef({ mood, hop, theme })
  props.current = { mood, hop, theme }

  useEffect(() => {
    if (!host.current) return
    let made: RooEngine | null = null
    try {
      made = new RooEngine(host.current, { framing, quiet, onReady, onFail })
      made.set(props.current)
      engine.current = made
    } catch {
      onFail()
    }
    return () => {
      made?.dispose()
      engine.current = null
    }
    // The engine is made once per view; its look follows the props below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    engine.current?.set({ mood, hop, theme })
  }, [mood, hop, theme])

  return <span ref={host} aria-hidden="true" className={className} />
}
