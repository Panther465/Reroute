import { motion } from 'motion/react'
import { Tag } from '@/components/ui/Tag'
import { rupees } from '@/lib/format'

export interface OptionCardData {
  optionId: string
  label: string
  extraFareInr: number
  consequence: string
  tags: string[]
}

/** A radio card. The selection outline slides between cards with a shared layout animation. */
export function OptionCards({ name, options, value, onChange, legend }: { name: string; options: OptionCardData[]; value: string; onChange: (id: string) => void; legend: string }) {
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-col gap-3">
        {options.map((o) => {
          const on = o.optionId === value
          return (
            <label
              key={o.optionId}
              className={`relative block cursor-pointer rounded-card border p-4 transition-colors duration-[var(--dur-quick)] has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                on ? 'border-transparent bg-green-tint' : 'border-line bg-surface [@media(hover:hover)]:hover:border-line-strong'
              }`}
            >
              {on && (
                <motion.span
                  layoutId={`${name}-ring`}
                  aria-hidden="true"
                  className="pointer-events-none absolute -inset-px rounded-card border-2 border-green"
                  transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                />
              )}
              <input type="radio" name={name} value={o.optionId} checked={on} onChange={() => onChange(o.optionId)} className="sr-only" />
              <span className="relative flex items-start justify-between gap-3">
                <span className="t-title text-ink">{o.label}</span>
                <span className={`shrink-0 t-title tnum ${o.extraFareInr > 0 ? 'text-red-ink' : 'text-green-ink'}`}>
                  {o.extraFareInr > 0 ? `+${rupees(o.extraFareInr)}` : 'No extra cost'}
                </span>
              </span>
              <span className={`relative mt-1 block t-small ${on ? 'text-ink' : 'text-ink-2'}`}>{o.consequence}</span>
              {o.tags.length > 0 && (
                <span className="relative mt-3 flex flex-wrap gap-2">
                  {o.tags.map((t) => (
                    <Tag key={t} tone={on ? 'green-outline' : 'grey-outline'}>
                      {t}
                    </Tag>
                  ))}
                </span>
              )}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
