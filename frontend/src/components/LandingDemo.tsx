import { motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { Segmented } from '@/components/ui/Choice'
import { EASE_OUT } from '@/lib/motion'
import { FlipTime } from './RerouteHero'

// The golden demo day (project brief, section 16), as Reroute's planner plans and re-plans it: these
// times are the planner's own answers, checked by the golden test (backend/tests/planner/test_golden.py).
type Delay = 'none' | '15' | '40'
type Fix = 'cab' | 'cheap'
interface DayState {
  bank: string
  office: string
  home: string
  extra: number
  kept: number
  title: string
  body: string
}
const DAYS: Record<'none' | '15' | 'cab' | 'cheap', DayState> = {
  none: { bank: '12:25', office: '15:40', home: '16:50', extra: 0, kept: 3, title: 'On time', body: 'Leave the hotel at 08:50: metro, then a shared auto to the meeting in Whitefield.' },
  '15': {
    bank: '12:40',
    office: '15:55',
    home: '17:05',
    extra: 0,
    kept: 3,
    title: 'Everything still fits',
    body: 'Reroute moves the later stops 15 min by itself. Nothing to choose, no extra cost.',
  },
  cab: {
    bank: '12:35',
    office: '15:50',
    home: '17:00',
    extra: 350,
    kept: 3,
    title: 'Something has to give',
    body: 'The office closes at 17:00. A cab to the bank keeps all three tasks for ₹350 more.',
  },
  cheap: {
    bank: '13:05',
    office: '10:00',
    home: '16:15',
    extra: 0,
    kept: 2,
    title: 'Something has to give',
    body: 'Keep it cheap: the university office moves to tomorrow at 10:00. No extra fare.',
  },
}

const H = 20
const M = 105
const B = 195
const O = 280
const Y = 52

/**
 * The landing page's one live thing: run the meeting late and watch the day re-route, as the app does.
 * On time, 15 minutes (the day shifts by itself) or 40 minutes (two explained options, and you choose).
 */
export function LandingDemo() {
  const reduce = !!useReducedMotion()
  const [delay, setDelay] = useState<Delay>('none')
  const [fix, setFix] = useState<Fix>('cab')
  const key = delay === '40' ? fix : delay
  const day = DAYS[key]
  const before = DAYS.none
  const cab = key === 'cab'
  const cheap = key === 'cheap'
  const draw = (delayS: number) => (reduce ? { initial: false as const } : { initial: { pathLength: 0 }, animate: { pathLength: 1 }, transition: { delay: delayS, duration: 0.5, ease: EASE_OUT } })

  const stations = [
    { x: H, name: 'Hotel', time: '08:50' },
    { x: M, name: 'Meeting', time: delay === 'none' ? '10:00' : '10:55' },
    { x: B, name: 'Bank', time: day.bank },
    { x: O, name: cheap ? 'Office, tomorrow' : 'Office', time: day.office },
  ]

  return (
    <div className="rounded-card border border-line bg-surface p-5 lg:p-6">
      <Segmented<Delay>
        label="Run the meeting late"
        value={delay}
        onChange={setDelay}
        options={[
          { value: 'none', label: 'On time' },
          { value: '15', label: '15 min' },
          { value: '40', label: '40 min' },
        ]}
      />

      <div className="relative mt-6 aspect-[25/8] w-full" aria-hidden="true">
        <svg viewBox="0 0 300 96" className="absolute inset-0 size-full overflow-visible" fill="none" strokeLinecap="round">
          {/* Hotel to meeting: metro, then a shared auto */}
          <path d={`M${H} ${Y}H${M - 25}`} stroke="var(--blue)" strokeWidth="6" />
          <path d={`M${M - 25} ${Y}H${M}`} stroke="var(--green)" strokeWidth="6" />
          {/* Meeting to bank: metro and shared auto, or a cab arcing over them */}
          <motion.g animate={{ opacity: cab ? 0.25 : 1 }} transition={{ duration: 0.2 }}>
            <path d={`M${M} ${Y}H${B - 28}`} stroke="var(--blue)" strokeWidth="6" strokeDasharray={cab ? '5 7' : undefined} />
            <path d={`M${B - 28} ${Y}H${B}`} stroke="var(--green)" strokeWidth="6" strokeDasharray={cab ? '5 7' : undefined} />
          </motion.g>
          {cab && <motion.path key="cab" d={`M${M} ${Y}C${M + 22} ${Y - 46} ${B - 22} ${Y - 46} ${B} ${Y}`} stroke="var(--ink)" strokeWidth="6" {...draw(0.1)} />}
          {/* Bank to office: a verified shared auto, or nothing today when the office moves */}
          <motion.path d={`M${B} ${Y}H${O}`} stroke="var(--green)" strokeWidth="6" strokeDasharray={cheap ? '5 7' : undefined} animate={{ opacity: cheap ? 0.25 : 1 }} transition={{ duration: 0.2 }} />
          {stations.map((s, i) => {
            const now = i === 1 && delay !== 'none'
            const hollow = i === 3 && cheap
            return (
              <circle
                key={s.x}
                cx={s.x}
                cy={Y}
                r="7"
                fill={now ? 'var(--yellow)' : hollow ? 'var(--ground)' : 'var(--surface)'}
                stroke={hollow ? 'var(--line-strong)' : 'var(--ink)'}
                strokeWidth="3"
                strokeDasharray={hollow ? '3 3' : undefined}
              />
            )
          })}
        </svg>
        {stations.map((s, i) => (
          <div key={s.x} className="absolute flex w-24 -translate-x-1/2 flex-col items-center text-center" style={{ left: `${(s.x / 300) * 100}%`, top: `${((Y + 14) / 96) * 100}%` }}>
            <span className="t-caption text-ink">
              <FlipTime value={s.time} changed={i > 0 && s.time !== (i === 1 ? '10:00' : i === 2 ? before.bank : before.office)} index={i} reduce={reduce} />
            </span>
            <span className="t-small text-ink-2">{s.name}</span>
          </div>
        ))}
        {cab && (
          <motion.span
            className="absolute rounded-tag bg-ink px-2 py-0.5 t-caption text-on-ink"
            style={{ left: `${((M + B) / 2 / 300) * 100}%`, top: '-6%', x: '-50%' }}
            initial={reduce ? false : { opacity: 0, transform: 'translateY(6px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            transition={{ delay: 0.45, duration: 0.2, ease: EASE_OUT }}
          >
            Cab, +₹350
          </motion.span>
        )}
      </div>

      {delay === '40' && (
        <div className="mt-6">
          <Segmented<Fix>
            label="Choose how to fix the rest of the day"
            value={fix}
            onChange={setFix}
            options={[
              { value: 'cab', label: 'Cab to the bank' },
              { value: 'cheap', label: 'Keep it cheap' },
            ]}
          />
        </div>
      )}

      <div role="status" className="mt-6">
        <p className="t-title text-ink">{day.title}</p>
        <p className="mt-1 t-body text-ink-2">{day.body}</p>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4 tnum">
        <div>
          <dt className="t-small text-muted">Back at the hotel</dt>
          <dd className="t-title text-ink">{day.home}</dd>
        </div>
        <div>
          <dt className="t-small text-muted">Extra fare</dt>
          <dd className="t-title text-ink">{day.extra ? `+₹${day.extra}` : '₹0'}</dd>
        </div>
        <div>
          <dt className="t-small text-muted">Tasks today</dt>
          <dd className="t-title text-ink">{day.kept} of 3</dd>
        </div>
      </dl>
    </div>
  )
}
