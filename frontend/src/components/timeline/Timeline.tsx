import { Ban, ShieldCheck, TriangleAlert } from 'lucide-react'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { Fragment, useId, type ReactNode } from 'react'
import { MODE_META, ModeIcon } from '@/components/icons'
import { Tag } from '@/components/ui/Tag'
import { duration, hhmm, rupees, spokenDuration } from '@/lib/format'
import { T, useTl } from '@/lib/i18n'
import { stopEmoji } from '@/lib/stopEmoji'
import { setRooAnchor } from '@/lib/rooAnchor'
import type { Change } from '@/lib/store'
import type { DayView, LegView, StopView, TomorrowItem } from '@/lib/timeline'
import type { Mode, Segment } from '@/lib/types'
import { ModeChain } from './ModeChain'

const EASE_OUT = [0.16, 1, 0.3, 1] as const
const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const

const COLS = 'grid grid-cols-[3.5rem_2.5rem_minmax(0,1fr)] gap-x-3'

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

/** A stop's badge: its emoji in a ring. Green with a tick once done, yellow where the traveller is. */
function Station({ status, emoji, pulse, justDone, reduce, hollow, delay, reveal }: { status: StopView['status']; emoji: string; pulse?: boolean; justDone?: boolean; reduce: boolean; hollow?: boolean; delay: number; reveal: boolean }) {
  const ring = hollow
    ? 'border-dashed border-line-strong bg-ground'
    : status === 'now'
      ? 'border-yellow bg-surface ring-4 ring-yellow/25'
      : status === 'done'
        ? 'border-green bg-green-tint'
        : 'border-line-strong bg-surface'
  return (
    <motion.span
      className="relative z-10 flex size-10 items-center justify-center"
      initial={reveal && !reduce ? { scale: 0.6, opacity: 0 } : false}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ delay, duration: 0.24, ease: EASE_OUT }}
    >
      {pulse && !reduce && (
        <motion.span
          aria-hidden="true"
          // Tests skip looping animations when waiting for a settled screen.
          data-looping=""
          className="absolute inset-0 rounded-full bg-yellow"
          initial={{ opacity: 0.6, scale: 1 }}
          animate={{ opacity: 0, scale: 1.6 }}
          transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <motion.span
        key={status}
        className={`relative flex size-10 items-center justify-center rounded-full border-[3px] text-lg leading-none ${ring}`}
        initial={justDone && !reduce ? { scale: 0.8 } : false}
        animate={{ scale: 1 }}
        transition={{ duration: 0.16, ease: EASE_OUT }}
      >
        <span aria-hidden="true" className={status === 'done' && !hollow ? 'opacity-60' : ''}>
          {emoji}
        </span>
        {status === 'done' && !hollow && (
          <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full border-2 border-ground bg-green">
            <svg viewBox="0 0 10 10" className="size-2.5 text-on-green" aria-hidden="true">
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
          </span>
        )}
      </motion.span>
    </motion.span>
  )
}

function stopTags(stop: { task?: StopView['task'] }) {
  const t = stop.task
  const tags: ReactNode[] = []
  if (t?.fixedStart) tags.push(<Tag key="fx" tone="blue"><span aria-hidden="true">📌</span> Fixed {t.fixedStart}</Tag>)
  if (t?.window) tags.push(<Tag key="w" tone="green-outline"><span aria-hidden="true">🕓</span> Open till {t.window.closesAt}</Tag>)
  if (t?.hoursUnknown) tags.push(<Tag key="h" tone="grey-outline"><span aria-hidden="true">❔</span> Hours not known</Tag>)
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
  if (leg.rough) parts.push('a rough estimate from the distance')
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
      <span className="relative inline-flex h-7 items-center gap-1 rounded-full bg-yellow px-3 t-caption text-on-yellow tnum shadow-sm">
        <span>📍</span>
        <T k="Now" /> {hhmm(clock)}
      </span>
    </motion.div>
  )
}

/** A leg reads as a soft card between two stops; once travelled it shrinks back to a plain line. */
function LegButton({ readOnly, done, label, onClick, selected, children }: { readOnly?: boolean; done: boolean; label: string; onClick: () => void; selected: boolean; children: ReactNode }) {
  const look = selected ? 'border-green bg-surface' : done ? 'border-transparent' : 'border-line bg-surface/60'
  const cls = `-mx-1 block w-[calc(100%+0.5rem)] rounded-card border-2 px-3 ${done ? 'py-1.5' : 'py-2.5'} text-left transition-colors duration-[var(--dur-quick)] ${look} ${
    selected ? '' : '[@media(hover:hover)]:hover:bg-surface'
  }`
  if (readOnly) {
    return (
      <div className={`-mx-1 rounded-card border-2 px-3 ${done ? 'border-transparent py-1.5' : 'border-line bg-surface/60 py-2.5'}`}>
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
  /** The stop the traveller said they left ("I've left"), before the clock gets there. */
  departedFrom?: string | null
}

export function Timeline({ view, clock, change, reveal, onLeg, onStop, selectedSeq, readOnly, tomorrowLabel, departedFrom }: TimelineProps) {
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
  const tomorrow = view.tomorrow

  return (
    <LayoutGroup>
      <div className="relative">
        {reveal && !reduce && (
          <motion.div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[calc(3.5rem+0.75rem)] z-[5] w-10 origin-bottom bg-ground"
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
            const finished = stop.status === 'done' || stop.task?.state === 'done'
            const here = stop.status === 'now' && riding?.toId !== stop.id && departedFrom !== stop.id
            const content = (
              <>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={`t-title transition-colors duration-[var(--dur-quick)] ${finished ? 'text-ink-2' : 'text-ink'}`}>{stop.title}</span>
                  {finished && stop.kind === 'task' && <Tag tone="green">Done</Tag>}
                  {here && <Tag tone="yellow">You're here</Tag>}
                  {stop.status === 'now' && riding?.toId === stop.id && <Tag tone="yellow">On the way</Tag>}
                  {departedFrom === stop.id && <Tag tone="sunken">You’ve left</Tag>}
                </span>
                <span className="mt-0.5 block t-small text-muted">{stop.area}</span>
                {stop.kind === 'task' && stop.task!.durationMin > 0 && !finished && (
                  <span className="mt-0.5 block t-small text-ink-2 tnum">
                    {hhmm(stop.time)} to {hhmm(stop.end)}, {duration(stop.task!.durationMin)}
                  </span>
                )}
                {stop.kind === 'start' && <span className="mt-0.5 block t-small text-muted">Where the day starts</span>}
                {stop.kind === 'end' && <span className="mt-0.5 block t-small text-muted">Back for the night</span>}
                {(tags.length > 0 || stop.problem) && !finished && (
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
                  <div className={`col-start-1 row-start-1 pt-2 ${finished ? 'text-muted' : 'text-ink'}`}>
                    <FlipTime value={stop.time} flipIndex={changedOrder.indexOf(stop.id)} change={change} reduce={reduce} />
                  </div>
                  <div className={`relative col-start-2 row-start-1 flex justify-center ${stop.status === 'now' ? 'row-span-2' : ''}`}>
                    <Connector segments={inLeg?.segments} at="top" change={change?.changedLegs.includes(inLeg?.seq ?? -1) ? change : null} reduce={reduce} />
                    <Connector segments={outLeg?.segments} at="bottom" change={change?.changedLegs.includes(outLeg?.seq ?? -1) ? change : null} reduce={reduce} />
                    <Station
                      emoji={stopEmoji(stop.title, stop.kind)}
                      status={stop.status}
                      pulse={stop.status === 'now' && pulseNow}
                      justDone={change?.kind === 'checkin' && stop.status === 'done' && beforeStatus.get(stop.id) !== 'done'}
                      reduce={reduce}
                      delay={i * 0.04 + 0.05}
                      reveal={reveal}
                    />
                  </div>
                  <div className="col-start-3 row-start-1 pb-5 pt-1">
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
                      {/* Roo rides here, on the Now line, and moves with it through the day. */}
                      {!readOnly && <span ref={setRooAnchor} className="absolute -top-3 right-0" />}
                    </div>
                  )}
                </motion.li>
                {outLeg && (
                  <motion.li layout="position" transition={layoutT} className={`${COLS} relative`}>
                    <div />
                    <div className={`relative ${outLeg.status === 'done' ? 'min-h-14' : 'min-h-28'}`}>
                      <LegLine leg={outLeg} old={oldByTo.get(outLeg.toId)} change={change} reduce={reduce} />
                      {riding?.seq === outLeg.seq && <ProgressMarker leg={outLeg} clock={clock} reduce={reduce} />}
                    </div>
                    <div className="py-2 pb-5">
                      <LegButton readOnly={readOnly} done={outLeg.status === 'done'} label={legSpoken(outLeg)} onClick={() => onLeg(outLeg)} selected={selectedSeq === outLeg.seq}>
                        <span className="flex items-center gap-2">
                          <ModeChain segments={outLeg.segments} size={outLeg.status === 'done' ? 16 : 20} />
                          <span className={`t-small font-bold ${outLeg.status === 'done' ? 'text-muted' : 'text-ink'}`}>{outLeg.label}</span>
                        </span>
                        {outLeg.status === 'done' ? (
                          <span className="mt-0.5 block t-small text-muted tnum">
                            Travelled, {outLeg.estimate ? 'about ' : ''}
                            {duration(outLeg.travelMin)}, {outLeg.fareInr ? rupees(outLeg.fareInr) : 'free'}
                          </span>
                        ) : (
                          <>
                            <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 t-small text-ink-2 tnum">
                              <span className="inline-flex items-center gap-1 font-bold text-ink">
                                <span>🚶</span>Leave {outLeg.leaveBy}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <span>⏱️</span>
                                {outLeg.estimate ? 'About ' : ''}
                                {duration(outLeg.travelMin)}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <span>💰</span>
                                {outLeg.fareInr ? rupees(outLeg.fareInr) : 'Free'}
                              </span>
                            </span>
                            {outLeg.waitMin >= 10 && (
                              <span className="mt-1 flex items-center gap-1 t-small text-muted tnum">
                                <span>☕</span>Arrive {outLeg.arriveAt}, {duration(outLeg.waitMin)} early
                              </span>
                            )}
                          </>
                        )}
                        {outLeg.rough && outLeg.status !== 'done' && (
                          <span className="mt-2 flex">
                            <Tag tone="grey-outline">
                              <span aria-hidden="true">≈</span> Rough estimate
                            </Tag>
                          </span>
                        )}
                        {outLeg.raasta && outLeg.status !== 'done' && (
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
            <h3 className="t-title text-ink">Tomorrow, {tomorrowLabel}</h3>
            <p className="mb-4 t-small text-muted">Reroute plans these in the morning, from where you are then.</p>
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
      <div className="relative pt-2 t-time text-ink-2 tnum">{hhmm(item.time)}</div>
      <div className="relative flex justify-center">
        <span className="flex size-10 items-center justify-center rounded-full border-[3px] border-dashed border-line-strong text-lg leading-none" aria-hidden="true">
          <span className="opacity-70">{stopEmoji(item.title)}</span>
        </span>
      </div>
      <div className="relative pb-5 pt-1">
        <span className="block t-title text-ink">{item.title}</span>
        <span className="block t-small text-muted">{item.area}</span>
        <span className="mt-2 flex flex-wrap gap-2">
          {item.moved ? <Tag tone="grey-outline">Moved from today</Tag> : item.task.fixedStart ? <Tag tone="ink">Fixed {item.task.fixedStart}</Tag> : null}
        </span>
      </div>
    </motion.li>
  )
}
