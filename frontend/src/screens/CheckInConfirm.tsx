import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { duration, hhmm, lowerFirst } from '@/lib/format'
import { T } from '@/lib/i18n'

/** Asked before marking done a task that doesn't start for more than 10 minutes, by the trip clock. */
export function CheckInConfirm({ open, onOpenChange, title, start, clock, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; start: number; clock: number; onConfirm: () => void }) {
  const name = lowerFirst(title)
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Is the ${name} already done?`}
      description={`It's planned for ${hhmm(start)}, about ${duration(Math.max(0, start - clock))} from now. Marking it done moves the rest of your day on.`}
      footer={
        <div className="flex flex-col gap-2">
          <Button full onClick={onConfirm}>
            <T k="Yes, it's done" />
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
