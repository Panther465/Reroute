import { CarTaxiFront, Footprints, TrainFront, type LucideProps } from 'lucide-react'
import type { SVGProps } from 'react'
import type { Mode } from '@/lib/types'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Base({ size = 20, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Three-wheeler with a canopy. Also used for tempos. */
export function AutoRickshaw(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M4 12V8.5A3.5 3.5 0 0 1 7.5 5h7.3a2 2 0 0 1 1.7.95L20 12" />
      <path d="M13 5v7" />
      <path d="M3 12h18v4h-1.5" />
      <path d="M3 12v4h1.5" />
      <path d="M8.5 16h7" />
      <circle cx="6.5" cy="17" r="2" />
      <circle cx="17.5" cy="17" r="2" />
    </Base>
  )
}

/** Flat roof with a small lightning bolt. */
export function ERickshaw(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M3 5h18" />
      <path d="M5 5v7" />
      <path d="M19 5v7" />
      <path d="m12.6 6.8-1.8 2.4h2.4l-1.8 2.4" />
      <path d="M3 12h18v4h-1.5" />
      <path d="M3 12v4h1.5" />
      <path d="M8.5 16h7" />
      <circle cx="6.5" cy="17" r="2" />
      <circle cx="17.5" cy="17" r="2" />
    </Base>
  )
}

type AnyIcon = (p: LucideProps & IconProps) => React.ReactElement | null

export const MODE_META: Record<Mode, { label: string; Icon: AnyIcon; tone: 'blue' | 'green' | 'ink' | 'walk' }> = {
  walk: { label: 'Walk', Icon: Footprints as AnyIcon, tone: 'walk' },
  metro: { label: 'Metro', Icon: TrainFront as AnyIcon, tone: 'blue' },
  shared_auto: { label: 'Shared auto', Icon: AutoRickshaw as AnyIcon, tone: 'green' },
  e_rickshaw: { label: 'E-rickshaw', Icon: ERickshaw as AnyIcon, tone: 'green' },
  tempo: { label: 'Tempo', Icon: AutoRickshaw as AnyIcon, tone: 'green' },
  cab: { label: 'Cab', Icon: CarTaxiFront as AnyIcon, tone: 'ink' },
}

export function ModeIcon({ mode, size = 20, className }: { mode: Mode; size?: number; className?: string }) {
  const { Icon } = MODE_META[mode]
  return <Icon size={size} strokeWidth={1.75} aria-hidden="true" className={className} />
}

/** Mode colour as a text colour class, for icons beside a leg. */
export function modeTextClass(mode: Mode) {
  const tone = MODE_META[mode].tone
  return tone === 'blue' ? 'text-blue' : tone === 'green' ? 'text-green' : 'text-ink'
}

/** The app mark: a three-station line with one bend. */
export function RouteMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <rect width="32" height="32" rx="8" fill="var(--green)" />
      <path d="M9 23V15a6 6 0 0 1 6-6h8" fill="none" stroke="var(--on-green)" strokeWidth="2.4" strokeLinecap="round" />
      {[
        [9, 23],
        [10.76, 10.76],
        [23, 9],
      ].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.7" fill="var(--green)" stroke="var(--on-green)" strokeWidth="2.2" />
      ))}
    </svg>
  )
}

/** Solid fill class for a mode's line colour. */
export function modeBgClass(mode: Mode) {
  const tone = MODE_META[mode].tone
  return tone === 'blue' ? 'bg-blue' : tone === 'green' ? 'bg-green' : 'bg-ink'
}
