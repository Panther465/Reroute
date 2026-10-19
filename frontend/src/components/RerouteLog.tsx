import { History, Undo2 } from 'lucide-react'
import type { Trip } from '@/api/types'
import { Sheet } from '@/components/ui/Sheet'
import { undo } from '@/lib/actions'
import { hhmm } from '@/lib/format'
import { T, useTl } from '@/lib/i18n'
import { localMinutes } from '@/lib/timeline'

export function RerouteLog({ trip, open, onOpenChange }: { trip: Trip | undefined; open: boolean; onOpenChange: (o: boolean) => void }) {
  const log = trip?.log ?? []
  const title = useTl()('Reroute log')
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title.text} titleLang={title.lang} description="What Reroute changed in your day, and when. You can undo the latest change.">
      {log.length === 0 || !trip ? (
        <div className="py-4">
          <History size={24} strokeWidth={1.75} aria-hidden="true" className="text-muted" />
          <p className="mt-3 t-title text-ink">No changes yet</p>
          <p className="mt-1 t-body text-ink-2">When Reroute moves a stop, it shows up here with an Undo.</p>
        </div>
      ) : (
        <ol className="divide-y divide-line rounded-card border border-line">
          {log.map((entry) => (
            <li key={entry.logId} className="flex items-center gap-3 px-4 py-3">
              <span className="w-12 shrink-0 t-time text-ink tnum">{hhmm(localMinutes(entry.at, trip.day, trip.utcOffset))}</span>
              <div className="min-w-0 flex-1">
                <p className={`t-body ${entry.undone ? 'text-muted line-through' : 'text-ink'}`}>{entry.text}</p>
                <p className="t-small text-muted">{entry.undone ? 'Undone' : entry.kind === 'undo' ? 'You undid a change' : entry.automatic ? 'Done by Reroute' : 'You chose this'}</p>
              </div>
              {entry.canUndo && entry.previousVersion != null && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false)
                    void undo(trip.tripId, entry.previousVersion!)
                  }}
                  className="flex min-h-12 shrink-0 items-center gap-2 rounded-control px-3 t-title text-ink underline decoration-2 underline-offset-4 [@media(hover:hover)]:hover:bg-sunken"
                >
                  <Undo2 size={20} strokeWidth={1.75} aria-hidden="true" />
                  <T k="Undo" />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Sheet>
  )
}
