import { CircleQuestionMark, Clock, Pin, Ruler, ShieldCheck, ShieldQuestionMark, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { duration } from '@/lib/format'
import { T } from '@/lib/i18n'

export type TagTone = 'ink' | 'green-outline' | 'grey-outline' | 'green' | 'blue' | 'red' | 'yellow' | 'sunken'

const tones: Record<TagTone, string> = {
  ink: 'bg-ink text-on-ink',
  'green-outline': 'border border-green text-green-ink',
  'grey-outline': 'border border-line-strong text-ink-2',
  green: 'bg-green-tint text-green-ink',
  blue: 'bg-blue-tint text-blue',
  red: 'bg-red-tint text-red-ink',
  yellow: 'bg-yellow text-on-yellow',
  sunken: 'bg-sunken text-ink-2',
}

export function Tag({ tone = 'grey-outline', icon, children, className = '' }: { tone?: TagTone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    // Never squeezed by its neighbours; it only wraps its own words when it's wider than the column.
    <span className={`inline-flex min-h-6 max-w-full shrink-0 items-center gap-1 rounded-tag px-2 py-0.5 t-caption ${tones[tone]} ${className}`}>
      {icon}
      {children}
    </span>
  )
}

const tagIcon = (Icon: LucideIcon) => <Icon size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />

// One vocabulary for a task's facts, the same on every screen (UI brief 7.11).

export function FixedTag({ at }: { at: string }) {
  return (
    <Tag tone="ink" icon={tagIcon(Pin)}>
      Fixed {at}
    </Tag>
  )
}

export function HoursTag({ closesAt }: { closesAt: string }) {
  return (
    <Tag tone="green-outline" icon={tagIcon(Clock)}>
      Open till {closesAt}
    </Tag>
  )
}

export function HoursUnknownTag() {
  return (
    <Tag tone="grey-outline" icon={tagIcon(CircleQuestionMark)}>
      Hours not known
    </Tag>
  )
}

export function DurationTag({ min }: { min: number }) {
  return <Tag tone="grey-outline">{duration(min)}</Tag>
}

/** Must do and If there is time; "Should do" (the default) only where every priority is spelled out. */
export function PriorityTag({ priority, always = false }: { priority: number; always?: boolean }) {
  if (priority === 1) return <Tag tone="grey-outline">Must do</Tag>
  if (priority === 3) return <Tag tone="sunken">If there is time</Tag>
  return always ? <Tag tone="grey-outline">Should do</Tag> : null
}

export function RouteCheckTag({ verified }: { verified: boolean }) {
  return verified ? (
    <Tag tone="green" icon={tagIcon(ShieldCheck)}>
      <T k="Verified" />
    </Tag>
  ) : (
    <Tag tone="grey-outline" icon={tagIcon(ShieldQuestionMark)}>
      <T k="Unverified" />
    </Tag>
  )
}

export function RoughTag() {
  return (
    <Tag tone="grey-outline" icon={tagIcon(Ruler)}>
      Rough estimate
    </Tag>
  )
}
