import { Ban, ShieldCheck, TriangleAlert } from 'lucide-react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { Fragment, useId, type ReactNode } from 'react'
import { MODE_META, ModeIcon } from '@/components/icons'
import { Tag } from '@/components/ui/Tag'
import { duration, hhmm, rupees, spokenDuration } from '@/lib/format'
import { T, useTl } from '@/lib/i18n'
import type { Change } from '@/lib/store'
import type { DayView, LegView, StopView, TomorrowItem } from '@/lib/timeline'
import type { Mode, Segment } from '@/lib/types'
import { ModeChain } from './ModeChain'

const EASE_OUT = [0.16, 1, 0.3, 1] as const
const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const

const COLS = 'grid grid-cols-[3.5rem_1.5rem_minmax(0,1fr)] gap-x-3'

function segClass(mode: Mode) {
  const tone = MODE_META[mode].tone
  if (tone === 'walk') return 'rr-walk'
  return tone === 'blue' ? 'bg-blue' : tone === 'green' ? 'bg-green' : 'bg-ink'
}
function dashClass(mode: Mode) {
  const tone = MODE_META[mode].tone
  return `rr-dashed ${tone === 'blue' ? 'text-blue' : tone === 'green' ? 'text-green' : 'text-ink'}`
}

function Segments({ segments, dashed }: { segments: Segment[]; dashed?: boolean }) {
  return (
    <div className="absolute inset-y-0 left-1/2 flex w-1.5 -translate-x-1/2 flex-col">
      {segments.map((s, i) => (
        <div key={i} style={{ flexGrow: s.minutes }} className={`${dashed ? dashClass(s.mode) : segClass(s.mode)} min-h-2 w-1.5`} />
      ))}
    </div>
  )
}

/** A leg's line, with the reroute redraw (section 9: 160–360 ms fade/dash, 300–900 ms draw). */
function LegLine({ leg, old, change, reduce }: { leg: LegView; old?: LegView; change: Change | null; reduce: boolean }) {
  const changed = !!change && change.changedLegs.includes(leg.seq) && change.kind !== 'checkin'
  if (!changed || reduce) return <Segments segments={leg.segments} />
  if (change.kind === 'undo') {
    return (
      <motion.div key={change.token} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, ease: EASE_OUT }}>
        <Segments segments={leg.segments} />
      </motion.div>
    )
  }
  return (
    <Fragment key={change.token}>
      {old && (
        <>
          <motion.div className="absolute inset-0" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ delay: 0.16, duration: 0.2 }}>
            <Segments segments={old.segments} />
          </motion.div>
          <motion.div className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: [0, 0.3, 0.3, 0] }} transition={{ duration: 1.1, times: [0.145, 0.33, 0.85, 1] }}>
            <Segments segments={old.segments} dashed />
          </motion.div>
        </>
      )}
      <motion.div className="absolute inset-0 origin-top" initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: 0.3, duration: 0.6, ease: EASE_OUT }}>
        <Segments segments={leg.segments} />
      </motion.div>
    </Fragment>
  )
}

/**
 * Where the traveller is on the leg they're riding: a mode-coloured marker at the fraction of the
 * trip that has passed. It moves only when the clock moves (transform only, no loop).
 */
function ProgressMarker({ leg, clock, reduce }: { leg: LegView; clock: number; reduce: boolean }) {
  const span = Math.max(1, leg.arriveMin - leg.leaveMin)
  const f = Math.min(1, Math.max(0, (clock - leg.leaveMin) / span))
  let acc = 0
  const total = leg.segments.reduce((n, x) => n + x.minutes, 0) || 1
  const mode = leg.segments.find((x) => (acc += x.minutes) / total >= f)?.mode ?? leg.segments[leg.segments.length - 1].mode
  const ring = MODE_META[mode].tone === 'blue' ? 'border-blue text-blue' : MODE_META[mode].tone === 'green' ? 'border-green text-green' : 'border-ink text-ink'
  return (
    <>
      <motion.div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-20"
        initial={false}
        animate={{ y: `${f * 100}%` }}
        transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 120, damping: 24 }}
      >
        <motion.span
          className={`absolute left-1/2 top-0 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-surface ${ring}`}
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.24, ease: EASE_OUT }}
        >
          <ModeIcon mode={mode} size={14} />
        </motion.span>
      </motion.div>
      <span className="sr-only">
        On the way, arriving around {leg.arriveAt}
      </span>
    </>
  )
}

/** A timetable time. Flips like a split-flap board when it changes (180 ms per stop, 60 ms apart). */
function FlipTime({ value, flipIndex, change, reduce, className = 't-time' }: { value: number; flipIndex: number; change: Change | null; reduce: boolean; className?: string }) {
  const text = hhmm(value)
  const changed = flipIndex >= 0 && !!change && change.kind !== 'checkin'
  const flip = changed && change.kind === 'reroute' && !reduce
  return (
    <span className={`relative inline-block tnum ${className}`} style={{ perspective: 300 }}>
      <span key={changed ? `hl-${change.token}` : 'plain'} className={`relative inline-block rounded-[6px] px-1 -mx-1 ${changed && change.kind === 'reroute' ? 'rr-changed' : ''}`}>
        {changed && change.kind === 'reroute' && <span aria-hidden="true" className="rr-changed-bg absolute inset-0 -z-0 rounded-[6px] bg-yellow opacity-0" />}
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={text}
            className="relative inline-block"
            style={{ transformOrigin: '50% 50%', backfaceVisibility: 'hidden' }}
            initial={flip ? { rotateX: -90 } : changed && !reduce ? { opacity: 0 } : false}
            animate={{ rotateX: 0, opacity: 1, transition: { duration: flip ? 0.09 : 0.2, ease: EASE_OUT } }}
            exit={
              flip
                ? { rotateX: 90, transition: { delay: 0.7 + flipIndex * 0.06, duration: 0.09, ease: [0.4, 0, 1, 1] } }
                : { opacity: 0, transition: { duration: reduce ? 0 : 0.15 } }
            }
          >
            {text}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  )
}

function Station({ status, pulse, justDone, reduce, hollow, delay, reveal }: { status: StopView['status']; pulse?: boolean; justDone?: boolean; reduce: boolean; hollow?: boolean; delay: number; reveal: boolean }) {
  const fill = hollow ? 'bg-transparent border-muted border-dashed' : status === 'now' ? 'bg-yellow border-ink' : status === 'done' ? 'bg-ink border-ink' : 'bg-surface border-ink'
  return (
    <motion.span
      className="relative z-10 mt-1 flex size-4 items-center justify-center"
      initial={reveal && !reduce ? { scale: 0.6, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ delay, duration: 0.24, ease: EASE_OUT }}
    >
      {pulse && !reduce && (
        <motion.span
          aria-hidden="true"
          className="absolute inset-0 rounded-full bg-yellow"
          initial={{ opacity: 0.6, scale: 1 }}
          animate={{ opacity: 0, scale: 1.8 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <motion.span
        key={status}
        className={`relative flex size-4 items-center justify-center rounded-full border-[3px] ${fill}`}
        initial={justDone && !reduce ? { scale: 0.8 } : false}
        animate={{ scale: 1 }}
        transition={{ duration: 0.16, ease: EASE_OUT }}
      >
        {status === 'done' && !hollow && (
          <svg viewBox="0 0 10 10" className="size-2.5 text-on-ink" aria-hidden="true">
            <motion.path
              d="M2 5.2l2 2 4-4.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={justDone && !reduce ? { pathLength: 0 } : false}
              animate={{ pathLength: 1 }}
              transition={{ delay: 0.08, duration: 0.2, ease: EASE_OUT }}
            />
          </svg>
        )}
      </motion.span>
    </motion.span>
  )
}

function stopTags(stop: { task?: StopView['task'] }) {
  const t = stop.task
  const tags: ReactNode[] = []
  if (t?.fixedStart) tags.push(<Tag key="fx" tone="ink">Fixed {t.fixedStart}</Tag>)
  if (t?.window) tags.push(<Tag key="w" tone="green-outline">Open till {t.window.closesAt}</Tag>)
  if (t?.hoursUnknown) tags.push(<Tag key="h" tone="grey-outline">Hours not known</Tag>)
  return tags
}

function stopSpoken(stop: StopView, now: number) {
  const parts = [hhmm(stop.time), stop.title, stop.area]
  if (stop.task?.fixedStart) parts.push('fixed time')
  if (stop.task?.window) parts.push(`open till ${stop.task.window.closesAt}`)
  if (stop.problem === 'closed') parts.push('closes before you can finish')
  if (stop.problem === 'late') parts.push('at risk: you may miss the fixed time')
  parts.push(stop.status === 'now' ? `now, ${hhmm(now)}` : stop.status === 'done' ? 'done' : '')
  return parts.filter(Boolean).join(', ')
}

export function legSpoken(leg: LegView) {
  const parts = [leg.label, spokenDuration(leg.travelMin), leg.fareInr ? `${leg.fareInr} rupees` : 'free']
  if (leg.raasta) parts.push(leg.raasta.status === 'verified' ? 'verified Raasta route' : 'unverified Raasta route')
  if (leg.status === 'done') parts.push('done')
  else parts.push(`leave ${leg.leaveBy}`)
  return parts.join(', ')
}

function Connector({ segments, at, change, reduce }: { segments?: Segment[]; at: 'top' | 'bottom'; change: Change | null; reduce: boolean }) {
  if (!segments?.length) return null
  const mode = at === 'top' ? segments[segments.length - 1].mode : segments[0].mode
  return (
    <motion.span
      key={change && change.kind !== 'checkin' && !reduce ? `c-${change.token}` : 'c'}
      aria-hidden="true"
      className={`absolute left-1/2 w-1.5 -translate-x-1/2 ${segClass(mode)} ${at === 'top' ? 'top-0 h-3' : 'bottom-0 top-3'}`}
      initial={change && change.kind === 'reroute' && !reduce ? { opacity: 0.3 } : false}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.6, duration: 0.3 }}
    />
  )
}

export function NowBar({ clock }: { clock: number }) {
  return (
    <motion.div layoutId="now-bar" transition={{ layout: { duration: 0.4, ease: EASE_IN_OUT } }} className="relative my-3 flex h-6 items-center" aria-hidden="true">
      <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-yellow" />
      <span className="relative inline-flex h-6 items-center rounded-full bg-yellow px-2.5 t-caption text-on-yellow tnum">
        <T k="Now" /> {hhmm(clock)}
      </span>
    </motion.div>
  )
}

function LegButton({ readOnly, label, onClick, selected, children }: { readOnly?: boolean; label: string; onClick: () => void; selected: boolean; children: ReactNode }) {
  const cls = `-mx-2 block w-[calc(100%+1rem)] rounded-control border-2 px-2 py-2 text-left transition-colors duration-[var(--dur-quick)] ${
    selected ? 'border-green bg-surface' : 'border-transparent [@media(hover:hover)]:hover:bg-surface'
  }`
  if (readOnly) {
    return (
      <div className="-mx-2 px-2 py-2">
        <span className="sr-only">{label}</span>
        <span aria-hidden="true">{children}</span>
      </div>
    )
  }
  return (
    <button type="button" onClick={onClick} aria-current={selected ? 'true' : undefined} className={cls}>
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">{children}</span>
    </button>
  )
}

interface TimelineProps {
  view: DayView
  clock: number
  change: Change | null
  reveal: boolean
  onLeg: (leg: LegView) => void
  onStop: (stop: StopView) => void
  selectedSeq?: number | null
  readOnly?: boolean
  tomorrowLabel: string
}

export function Timeline({ view, clock, change, reveal, onLeg, onStop, selectedSeq, readOnly, tomorrowLabel }: TimelineProps) {
  const reduce = !!useReducedMotion()
  const listLabel = useTl()('Today')
  const listLabelId = useId()
  const { stops, legs } = view
  const legTo = new Map(legs.map((l) => [l.toId, l]))
  const legFrom = new Map(legs.map((l) => [l.fromId, l]))
  const oldByTo = new Map((change?.before.legs ?? []).map((l) => [l.toId, l]))
  const changedOrder = stops.filter((s) => change?.changedStops.includes(s.id)).map((s) => s.id)
  const beforeStatus = new Map((change?.before.stops ?? []).map((s) => [s.id, s.status]))
  const nextLeave = view.nextLeg ? view.nextLeg.leaveMin : null
  // The leg the traveller is riding now: into the "now" station, between its leave and arrive times.
  const nowStop = stops[view.nowIndex]
  const riding = legs.find((l) => l.toId === nowStop?.id && clock >= l.leaveMin && clock < l.arriveMin) ?? null
  const pulseNow = nextLeave !== null && clock >= nextLeave - 10 && clock < nextLeave
  const layoutT = { layout: { duration: change?.kind === 'undo' ? 0.4 : 0.5, ease: EASE_IN_OUT } }
  const tomorrow = view.tomorrow.some((x) => x.moved) ? view.tomorrow : []

  return (
    <LayoutGroup>
      <div className="relative">
        {reveal && !reduce && (
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[calc(3.5rem+0.75rem)] z-[5] w-6 origin-bottom bg-ground"
            initial={{ scaleY: 1 }}
            animate={{ scaleY: 0 }}
            transition={{ duration: 0.6, ease: EASE_OUT }}
          />
        )}
        {/* Labelled by a hidden span so a Hindi label carries lang="hi" without marking the stops as Hindi. */}
        <span id={listLabelId} hidden lang={listLabel.lang}>
          {listLabel.text}
        </span>
        <ol aria-labelledby={listLabelId} className="relative">
          {stops.map((stop, i) => {
            const inLeg = legTo.get(stop.id)
            const outLeg = legFrom.get(stop.id)
            const tags = stopTags(stop)
            const interactive = stop.kind === 'task' && !readOnly
            const content = (
              <>
                <span className={`block t-title transition-colors duration-[var(--dur-quick)] ${stop.status === 'done' ? 'text-ink-2' : 'text-ink'}`}>{stop.title}</span>
                <span className="block t-small text-muted">{stop.area}</span>
                {stop.kind === 'task' && stop.task!.durationMin > 0 && (
                  <span className="block t-small text-muted tnum">
                    {stop.status === 'done' ? 'Done' : `Until ${hhmm(stop.end)}`}
                  </span>
                )}
                {stop.kind === 'end' && <span className="block t-small text-muted">Back for the night</span>}
                {(tags.length > 0 || stop.problem) && (
                  <span className="mt-2 flex flex-wrap gap-2">
                    {tags}
                    {stop.problem === 'late' && (
                      <Tag tone="red" icon={<TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />}>
                        Late for the fixed time
                      </Tag>
                    )}
                    {stop.problem === 'closed' && (
                      <Tag tone="red" icon={<Ban size={14} strokeWidth={1.75} aria-hidden="true" />}>
                        Closes before you finish
                      </Tag>
                    )}
                  </span>
                )}
              </>
            )
            return (
              <Fragment key={stop.id}>
                <motion.li layout="position" layoutId={stop.kind === 'task' ? `stop-${stop.id}` : undefined} transition={layoutT} className={`${COLS} relative`}>
                  <div className={`col-start-1 row-start-1 ${stop.status === 'done' ? 'text-ink-2' : 'text-ink'}`}>
                    <FlipTime value={stop.time} flipIndex={changedOrder.indexOf(stop.id)} change={change} reduce={reduce} />
                  </div>
                  <div className={`relative col-start-2 row-start-1 flex justify-center ${stop.status === 'now' ? 'row-span-2' : ''}`}>
                    <Connector segments={inLeg?.segments} at="top" change={change?.changedLegs.includes(inLeg?.seq ?? -1) ? change : null} reduce={reduce} />
                    <Connector segments={outLeg?.segments} at="bottom" change={change?.changedLegs.includes(outLeg?.seq ?? -1) ? change : null} reduce={reduce} />
                    <Station
                      status={stop.status}
                      pulse={stop.status === 'now' && pulseNow}
                      justDone={change?.kind === 'checkin' && stop.status === 'done' && beforeStatus.get(stop.id) !== 'done'}
                      reduce={reduce}
                      delay={i * 0.04 + 0.05}
                      reveal={reveal}
                    />
                  </div>
                  <div className="col-start-3 row-start-1 pb-5">
                    {interactive ? (
                      <button type="button" onClick={() => onStop(stop)} className="-mx-2 -mt-1 block w-[calc(100%+1rem)] rounded-control px-2 py-1 text-left [@media(hover:hover)]:hover:bg-surface">
                        <span className="sr-only">{stopSpoken(stop, clock)}</span>
                        <span aria-hidden="true">{content}</span>
                      </button>
                    ) : (
                      <div className="-mt-1 py-1">
                        <span className="sr-only">{stopSpoken(stop, clock)}</span>
                        <span aria-hidden="true">{content}</span>
                      </div>
                    )}
                  </div>
                  {stop.status === 'now' && (
                    <div className="relative z-10 col-start-1 col-end-4 row-start-2 -mt-2 mb-1">
                      <NowBar clock={clock} />
                      <span className="sr-only">Now {hhmm(clock)}</span>
                    </div>
                  )}
                </motion.li>
                {outLeg && (
                  <motion.li layout="position" transition={layoutT} className={`${COLS} relative`}>
                    <div />
                    <div className="relative min-h-24">
                      <LegLine leg={outLeg} old={oldByTo.get(outLeg.toId)} change={change} reduce={reduce} />
                      {riding?.seq === outLeg.seq && <ProgressMarker leg={outLeg} clock={clock} reduce={reduce} />}
                    </div>
                    <div className="py-2 pb-5">
                      <LegButton readOnly={readOnly} label={legSpoken(outLeg)} onClick={() => onLeg(outLeg)} selected={selectedSeq === outLeg.seq}>
                        <span className="flex items-center gap-2">
                          <ModeChain segments={outLeg.segments} />
                          <span className={`t-small font-bold ${outLeg.status === 'done' ? 'text-ink-2' : 'text-ink'}`}>{outLeg.label}</span>
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 t-small text-ink-2 tnum">
                          {outLeg.status === 'done' ? <span>Done</span> : <span>Leave {outLeg.leaveBy}</span>}
                          <span>{outLeg.estimate ? 'About ' : ''}{duration(outLeg.travelMin)}</span>
                          <span>{outLeg.fareInr ? rupees(outLeg.fareInr) : 'Free'}</span>
                        </span>
                        {outLeg.raasta && (
                          <span className="mt-2 flex">
                            {outLeg.raasta.status === 'verified' ? (
                              <Tag tone="green" icon={<ShieldCheck size={14} strokeWidth={1.75} aria-hidden="true" />}>
                                <T k="Verified" />
                              </Tag>
                            ) : (
                              <Tag tone="grey-outline">
                                <T k="Unverified" />
                              </Tag>
                            )}
                          </span>
                        )}
                      </LegButton>
                    </div>
                  </motion.li>
                )}
              </Fragment>
            )
          })}
        </ol>
        {tomorrow.length > 0 && (
          <motion.section layout="position" transition={layoutT} className="mt-6 border-t border-dashed border-line-strong pt-5" aria-label={`Tomorrow, ${tomorrowLabel}`}>
            <h3 className="mb-4 t-title text-ink">Tomorrow, {tomorrowLabel}</h3>
            <ol>
              {tomorrow.map((item) => (
                <TomorrowRow key={item.id} item={item} change={change} reduce={reduce} layoutT={layoutT} />
              ))}
            </ol>
          </motion.section>
        )}
      </div>
    </LayoutGroup>
  )
}

function TomorrowRow({ item, change, reduce, layoutT }: { item: TomorrowItem; change: Change | null; reduce: boolean; layoutT: object }) {
  const justMoved = !!change && change.kind === 'reroute' && change.movedTasks.includes(item.id) && !reduce
  return (
    <motion.li
      layoutId={item.moved ? `stop-${item.id}` : undefined}
      layout="position"
      transition={layoutT}
      className={`${COLS} relative`}
      initial={justMoved ? { scale: 1.02 } : false}
      animate={{ scale: 1 }}
    >
      {justMoved && (
        <motion.span aria-hidden="true" className="pointer-events-none absolute -inset-x-2 -inset-y-1 rounded-card bg-surface shadow-[var(--shadow-toast)]" initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ delay: 0.45, duration: 0.3 }} />
      )}
      <div className="relative t-time text-ink-2 tnum">{hhmm(item.time)}</div>
      <div className="relative flex justify-center">
        <span className="mt-1 block size-4 rounded-full border-[3px] border-dashed border-muted" aria-hidden="true" />
      </div>
      <div className="relative pb-5">
        <span className="block t-title text-ink">{item.title}</span>
        <span className="block t-small text-muted">{item.area}</span>
        <span className="mt-2 flex flex-wrap gap-2">
          {item.moved ? <Tag tone="grey-outline">Moved from today</Tag> : item.task.fixedStart ? <Tag tone="ink">Fixed {item.task.fixedStart}</Tag> : null}
        </span>
      </div>
    </motion.li>
  )
}
