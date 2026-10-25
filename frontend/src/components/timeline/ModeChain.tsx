import { ModeIcon, MODE_META, modeTextClass } from '@/components/icons'
import type { Segment } from '@/lib/types'

/** Mode icons for a leg, in order, each in its mode colour (grey, `muted`, once travelled). Labels live beside them. */
export function ModeChain({ segments, size = 20, muted = false }: { segments: Segment[]; size?: number; muted?: boolean }) {
  const modes = segments.map((s) => s.mode).filter((m, i, a) => a.indexOf(m) === i)
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {modes.map((m) => (
        <ModeIcon key={m} mode={m} size={size} className={muted ? 'text-muted' : modeTextClass(m)} />
      ))}
    </span>
  )
}

export function spokenModes(segments: Segment[]) {
  return segments.map((s) => MODE_META[s.mode].label).join(', then ')
}
