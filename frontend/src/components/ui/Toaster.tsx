import * as Toast from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { undo } from '@/lib/actions'
import { T } from '@/lib/i18n'
import { dismissToast, settleToast, useStore, useToasts } from '@/lib/store'

/** Inverted toast (ink background) with Undo. Radix pauses it on hover or focus and supports swipe. */
export function Toaster({ tripId }: { tripId: string | null }) {
  const toasts = useToasts()
  const chat = useStore((s) => s.rooChat)
  return (
    <Toast.Provider duration={8000} swipeDirection="down" label="Notification">
      {toasts.map((item) => {
        const serverUndo = tripId !== null && item.undoVersion != null
        const canUndo = serverUndo || !!item.onUndo
        return (
          <Toast.Root
            key={item.id}
            type="background"
            duration={item.duration}
            onOpenChange={(open) => {
              if (open) return
              settleToast(item.id, 'close')
              setTimeout(() => dismissToast(item.id), 200)
            }}
            className="rr-toast flex w-full items-center gap-2 rounded-card bg-ink py-2 pl-4 pr-2 text-on-ink shadow-[var(--shadow-toast)]"
          >
            <Toast.Description className="min-w-0 flex-1 py-2 t-body">{item.title}</Toast.Description>
            {canUndo && (
              <Toast.Action altText="Undo this change" asChild>
                <button
                  type="button"
                  onClick={() => {
                    if (item.onUndo) settleToast(item.id, 'undo')
                    dismissToast(item.id)
                    if (serverUndo) void undo(tripId!, item.undoVersion!)
                  }}
                  className="min-h-12 rounded-control px-3 t-title text-on-ink underline decoration-2 underline-offset-4 outline-offset-0 focus-visible:outline-on-ink"
                >
                  <T k="Undo" />
                </button>
              </Toast.Action>
            )}
            <Toast.Close aria-label="Dismiss" className="flex size-12 shrink-0 items-center justify-center rounded-control text-on-ink focus-visible:outline-on-ink">
              <X size={20} strokeWidth={1.75} aria-hidden="true" />
            </Toast.Close>
          </Toast.Root>
        )
      })}
      {/* On a desktop, toasts sit left of Roo's chat while it's open, never over its input. */}
      <Toast.Viewport
        className={`fixed inset-x-0 bottom-[calc(140px+env(safe-area-inset-bottom))] z-[60] mx-auto flex w-full max-w-[560px] flex-col gap-2 px-5 outline-none lg:bottom-8 lg:left-auto lg:mx-0 lg:w-[420px] lg:px-0 ${chat ? 'lg:right-[440px]' : 'lg:right-8'}`}
      />
    </Toast.Provider>
  )
}
