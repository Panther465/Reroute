import { TriangleAlert } from 'lucide-react'
import { useId, type InputHTMLAttributes, type ReactNode } from 'react'

export const inputClass =
  'block w-full min-h-12 rounded-control border-2 border-muted bg-surface px-4 t-body text-ink transition-colors duration-[var(--dur-quick)] focus-visible:border-focus aria-[invalid=true]:border-red'

export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-2 flex items-start gap-2 t-small text-red-ink">
      <TriangleAlert size={20} strokeWidth={1.75} aria-hidden="true" className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  )
}

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string
  /** "hi" when the label is a Hindi string. */
  labelLang?: string
  hint?: string
  error?: string
  trailing?: ReactNode
}

export function Field({ label, labelLang, hint, error, trailing, className = '', ...rest }: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  const described = [hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined
  return (
    <div className={className}>
      <label htmlFor={id} lang={labelLang} className="mb-2 block t-title text-ink">
        {label}
      </label>
      {hint && (
        <p id={hintId} className="-mt-1 mb-2 t-small text-muted">
          {hint}
        </p>
      )}
      <div className="relative">
        <input id={id} className={inputClass + (trailing ? ' pr-14' : '')} aria-invalid={error ? true : undefined} aria-describedby={described} {...rest} />
        {trailing && <div className="absolute inset-y-0 right-0 flex items-center pr-1">{trailing}</div>}
      </div>
      {error && <FieldError id={errId}>{error}</FieldError>}
    </div>
  )
}
