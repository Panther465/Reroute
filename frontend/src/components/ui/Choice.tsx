import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { useId, type ReactNode } from 'react'

/** Segmented control on Radix Toggle Group. Always keeps one value selected. */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
  full = true,
  hideLabel,
}: {
  label: string
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; icon?: ReactNode; lang?: string }[]
  full?: boolean
  hideLabel?: boolean
}) {
  const labelId = useId()
  return (
    <div>
      <p className={hideLabel ? 'sr-only' : 'mb-2 t-title text-ink'} id={labelId}>
        {label}
      </p>
      <ToggleGroup.Root
        type="single"
        value={value}
        onValueChange={(v) => v && onChange(v as T)}
        aria-labelledby={labelId}
        className={`flex flex-wrap gap-1 rounded-control bg-sunken p-1 ${full ? 'w-full' : 'inline-flex'}`}
      >
        {options.map((o) => (
          <ToggleGroup.Item
            key={o.value}
            value={o.value}
            lang={o.lang}
            className="flex min-h-12 flex-1 basis-0 items-center justify-center gap-2 whitespace-nowrap rounded-[11px] border-2 border-transparent px-3 t-title text-ink-2 transition-colors duration-[var(--dur-quick)] data-[state=on]:border-green data-[state=on]:bg-surface data-[state=on]:text-ink [@media(hover:hover)]:hover:data-[state=off]:bg-surface/60"
          >
            {o.icon}
            {o.label}
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </div>
  )
}

/** A radio group of chips (delay chips). Native radios keep arrow-key behaviour. */
export function ChipGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string
  name: string
  value: T | null
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <fieldset>
      <legend className="sr-only">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => {
          const on = value === o.value
          return (
            <label
              key={o.value}
              className={`relative flex min-h-12 cursor-pointer items-center rounded-tag border-2 px-4 t-title transition-colors duration-[var(--dur-quick)] has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
                on ? 'border-green bg-green-tint text-green-ink' : 'border-line-strong bg-surface text-ink'
              }`}
            >
              <input type="radio" name={name} value={o.value} checked={on} onChange={() => onChange(o.value)} className="sr-only" />
              {o.label}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

export function Switch({ checked, onChange, label, description, lang, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; lang?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-12 w-full items-center justify-between gap-4 rounded-control py-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span>
        <span className="block t-title text-ink" lang={lang}>
          {label}
        </span>
        {description && <span className="block t-small text-muted">{description}</span>}
      </span>
      <span
        aria-hidden="true"
        className={`relative inline-flex h-8 w-[52px] shrink-0 items-center rounded-full border-2 transition-colors duration-[var(--dur-quick)] ${checked ? 'border-green bg-green' : 'border-muted bg-sunken'}`}
      >
        <span
          className={`absolute left-[2px] h-6 w-6 rounded-full transition-transform duration-[var(--dur-quick)] ease-[var(--ease-out)] ${checked ? 'translate-x-5 bg-on-green' : 'translate-x-0 bg-muted'}`}
        />
      </span>
    </button>
  )
}
