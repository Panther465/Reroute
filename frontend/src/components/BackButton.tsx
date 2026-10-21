import { ChevronLeft } from 'lucide-react'
import { useCallback } from 'react'
import { useNavigate } from 'react-router'

/**
 * Back for a screen without the tab bar: through the app's history when there is some, else to
 * `fallback` (a link opened cold, or a reload, has no history; an installed app has no browser Back).
 */
export function useBack(fallback: string) {
  const navigate = useNavigate()
  return useCallback(() => (window.history.state?.idx > 0 ? navigate(-1) : navigate(fallback)), [navigate, fallback])
}

export function BackButton({ onClick, label = 'Back', className = '' }: { onClick: () => void; label?: string; className?: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={`-ml-3 flex size-12 shrink-0 items-center justify-center rounded-control text-ink [@media(hover:hover)]:hover:bg-sunken ${className}`}>
      <ChevronLeft size={24} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}
