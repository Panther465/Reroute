import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { AnimatePresence, motion, useDragControls, useReducedMotion, type PanInfo } from 'motion/react'
import { EASE_DRAWER, EASE_OUT } from '@/lib/motion'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { useIsDesktop } from '@/lib/hooks'
import { sheetOpened } from '@/lib/sheets'

const sheetSpring = { type: 'spring' as const, stiffness: 420, damping: 40 }

interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** Accessible title when `title` is not plain text. */
  titleLang?: string
}

/**
 * Bottom sheet on mobile, centred dialog on desktop. Radix Dialog handles focus trap,
 * Escape and focus return; Motion handles the spring and drag to dismiss.
 */
export function Sheet({ open, onOpenChange, title, description, children, footer, titleLang }: SheetProps) {
  const desktop = useIsDesktop()
  const reduce = useReducedMotion()
  const drag = useDragControls()
  // Sheets opened from app state (not a Radix trigger) still return focus to where it was (UI brief 11).
  const returnTo = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (open) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [open])
  // While a sheet is open, nothing else talks over it (Roo keeps quiet).
  useLayoutEffect(() => {
    if (!open) return
    sheetOpened(1)
    return () => sheetOpened(-1)
  }, [open])
  const restoreFocus = (e: Event) => {
    const el = returnTo.current
    if (el && el.isConnected) {
      e.preventDefault()
      el.focus()
    }
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    // A quick flick is enough; a slow drag has to go 140 px.
    if (info.offset.y > 140 || info.velocity.y > 400) onOpenChange(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.16 } }}
                exit={{ opacity: 0, transition: { duration: 0.14 } }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild forceMount onCloseAutoFocus={restoreFocus}>
              {desktop ? (
                <motion.div
                  className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(560px,calc(100vw-64px))] flex-col rounded-sheet bg-surface text-ink shadow-[var(--shadow-toast)] outline-none"
                  // Whole transform strings, not x/y/scale: the browser animates them off the main thread.
                  initial={{ opacity: 0, transform: `translate(-50%, -50%) scale(${reduce ? 1 : 0.98})` }}
                  animate={{ opacity: 1, transform: 'translate(-50%, -50%) scale(1)', transition: { duration: 0.24, ease: EASE_OUT } }}
                  exit={{ opacity: 0, transform: `translate(-50%, -50%) scale(${reduce ? 1 : 0.98})`, transition: { duration: 0.14, ease: EASE_OUT } }}
                >
                  <SheetBody title={title} description={description} footer={footer} onClose={() => onOpenChange(false)} titleLang={titleLang}>
                    {children}
                  </SheetBody>
                </motion.div>
              ) : (
                <motion.div
                  className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88vh] w-full max-w-[560px] flex-col rounded-t-sheet bg-surface text-ink shadow-[var(--shadow-sheet)] outline-none"
                  initial={{ y: reduce ? 0 : '100%', opacity: reduce ? 0 : 1 }}
                  animate={{ y: 0, opacity: 1, transition: reduce ? { duration: 0.16 } : sheetSpring }}
                  exit={{ y: reduce ? 0 : '100%', opacity: reduce ? 0 : 1, transition: { duration: 0.2, ease: EASE_DRAWER } }}
                  drag={reduce ? false : 'y'}
                  dragListener={false}
                  dragControls={drag}
                  dragConstraints={{ top: 0, bottom: 0 }}
                  dragElastic={{ top: 0, bottom: 0.6 }}
                  onDragEnd={onDragEnd}
                >
                  <div
                    className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
                    onPointerDown={(e) => drag.start(e)}
                    aria-hidden="true"
                  >
                    <span className="h-1 w-10 rounded-full bg-line-strong" />
                  </div>
                  <SheetBody title={title} description={description} footer={footer} onClose={() => onOpenChange(false)} onHeaderPointerDown={(e) => drag.start(e)} titleLang={titleLang}>
                    {children}
                  </SheetBody>
                </motion.div>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}

function SheetBody({
  title,
  description,
  children,
  footer,
  onClose,
  onHeaderPointerDown,
  titleLang,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  onHeaderPointerDown?: (e: React.PointerEvent) => void
  titleLang?: string
}) {
  return (
    <>
      <div className="flex shrink-0 items-start gap-3 px-5 pb-2 pt-2 lg:px-8 lg:pt-7" onPointerDown={onHeaderPointerDown}>
        <div className="min-w-0 flex-1 pt-2">
          <Dialog.Title className="t-display-2 text-ink" lang={titleLang}>
            {title}
          </Dialog.Title>
          {description ? (
            <Dialog.Description className="mt-2 t-body text-ink-2">{description}</Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">Dialog</Dialog.Description>
          )}
        </div>
        <Dialog.Close asChild>
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 flex size-12 shrink-0 items-center justify-center rounded-control text-ink [@media(hover:hover)]:hover:bg-sunken">
            <X size={24} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </Dialog.Close>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-3 lg:px-8">{children}</div>
      {footer && <div className="shrink-0 border-t border-line px-5 pb-[calc(16px+env(safe-area-inset-bottom))] pt-4 lg:px-8 lg:pb-7">{footer}</div>}
    </>
  )
}
