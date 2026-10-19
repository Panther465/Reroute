import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router'
import { Spinner } from './Spinner'

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive'

// The press (scale 0.97 over 90 ms) is plain CSS, so pages with buttons don't need the animation library.
const base =
  'relative inline-flex items-center justify-center gap-2 select-none whitespace-normal text-center t-title transition-[color,background-color,border-color,scale] duration-[var(--dur-quick)] motion-safe:[&:active:enabled:not([aria-busy])]:scale-[0.97] motion-safe:[&:active:enabled:not([aria-busy])]:duration-[90ms] disabled:cursor-not-allowed disabled:opacity-60'

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-green text-on-green rounded-control px-5 [@media(hover:hover)]:hover:enabled:bg-green-ink',
  secondary: 'border-2 border-ink text-ink rounded-control px-5 bg-transparent [@media(hover:hover)]:hover:enabled:bg-sunken',
  tertiary: 'text-ink underline underline-offset-4 decoration-2 rounded-tag px-2 [@media(hover:hover)]:hover:enabled:bg-sunken',
  destructive: 'border-2 border-red text-red-ink rounded-control px-5 bg-transparent [@media(hover:hover)]:hover:enabled:bg-red-tint',
}

export function buttonClass(variant: ButtonVariant = 'primary', size: 'lg' | 'md' = 'lg', full = false) {
  return [base, variants[variant], size === 'lg' ? 'min-h-[52px]' : 'min-h-12', full ? 'w-full' : ''].join(' ')
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant
  size?: 'lg' | 'md'
  full?: boolean
  icon?: ReactNode
  loading?: boolean
  /** Shown with a spinner once the action has taken longer than 300 ms. */
  loadingLabel?: ReactNode
  children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'lg', full, icon, loading, loadingLabel, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!loading) {
      setSlow(false)
      return
    }
    const t = setTimeout(() => setSlow(true), 300)
    return () => clearTimeout(t)
  }, [loading])
  const busy = loading && slow
  return (
    <button
      ref={ref}
      type={type}
      className={`${buttonClass(variant, size, full)} ${className}`}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      onClickCapture={(e) => {
        if (loading) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      <span>{busy && loadingLabel ? loadingLabel : children}</span>
    </button>
  )
})

export function ButtonLink({ variant = 'primary', size = 'lg', full, icon, className = '', children, ...rest }: LinkProps & { variant?: ButtonVariant; size?: 'lg' | 'md'; full?: boolean; icon?: ReactNode }) {
  return (
    <Link className={`${buttonClass(variant, size, full)} ${className}`} {...rest}>
      {icon}
      <span>{children}</span>
    </Link>
  )
}
