import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { duration, hhmm, lowerFirst } from '@/lib/format'
import { T } from '@/lib/i18n'

/** Asked before checking in to a task that doesn't start for more than 10 minutes, by the trip clock. */
export function CheckInConfirm({ open, onOpenChange, title, start, clock, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; start: number; clock: number; onConfirm: () => void }) {
  const name = lowerFirst(title)
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Check in at the ${name} now?`}
      description={`The ${name} is planned for ${hhmm(start)}, about ${duration(Math.max(0, start - clock))} from now. Checking in marks it done.`}
      footer={
        <div className="flex flex-col gap-2">
          <Button full onClick={onConfirm}>
            <T k="Check in now" />
          </Button>
          <Button variant="tertiary" size="md" className="self-center" onClick={() => onOpenChange(false)}>
            <T k="Not yet" />
          </Button>
        </div>
      }
    >
      <p className="t-small text-ink-2">You can undo it for a few seconds after.</p>
    </Sheet>
  )
}
