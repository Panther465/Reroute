import * as Tooltip from '@radix-ui/react-tooltip'
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

/** Icon-only button: 48 px target, aria-label, and a tooltip for pointer users. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }>(function IconButton(
  { label, children, className = '', ...rest },
  ref,
) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          className={`flex size-12 shrink-0 items-center justify-center rounded-control text-ink transition-colors duration-[var(--dur-quick)] [@media(hover:hover)]:hover:bg-sunken ${className}`}
          {...rest}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content sideOffset={4} className="z-[80] rounded-tag bg-ink px-2 py-1 t-caption text-on-ink">
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
})
