import * as Toast from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { undo } from '@/lib/actions'
import { useT } from '@/lib/i18n'
import { dismissToast, useToasts } from '@/lib/store'

/** Inverted toast (ink background) with Undo. Radix pauses it on hover or focus and supports swipe. */
export function Toaster({ tripId }: { tripId: string | null }) {
  const toasts = useToasts()
  const t = useT()
  return (
    <Toast.Provider duration={8000} swipeDirection="down" label="Notification">
      {toasts.map((item) => {
        const canUndo = tripId !== null && item.undoVersion != null
        return (
          <Toast.Root
            key={item.id}
            type="background"
            onOpenChange={(open) => !open && setTimeout(() => dismissToast(item.id), 200)}
            className="rr-toast flex w-full items-center gap-2 rounded-card bg-ink py-2 pl-4 pr-2 text-on-ink shadow-[var(--shadow-toast)]"
          >
            <Toast.Description className="min-w-0 flex-1 py-2 t-body">{item.title}</Toast.Description>
            {canUndo && (
              <Toast.Action altText="Undo this change" asChild>
                <button
                  type="button"
                  onClick={() => {
                    dismissToast(item.id)
                    void undo(tripId!, item.undoVersion!)
                  }}
                  className="min-h-12 rounded-control px-3 t-title text-on-ink underline decoration-2 underline-offset-4 outline-offset-0 focus-visible:outline-on-ink"
                >
                  {t('Undo')}
                </button>
              </Toast.Action>
            )}
            <Toast.Close aria-label="Dismiss" className="flex size-12 shrink-0 items-center justify-center rounded-control text-on-ink focus-visible:outline-on-ink">
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            </Toast.Close>
          </Toast.Root>
        )
      })}
      <Toast.Viewport className="fixed inset-x-0 bottom-[calc(140px+env(safe-area-inset-bottom))] z-[60] mx-auto flex w-full max-w-[560px] flex-col gap-2 px-5 outline-none lg:bottom-8 lg:left-auto lg:right-8 lg:mx-0 lg:w-[420px] lg:px-0" />
    </Toast.Provider>
  )
}
