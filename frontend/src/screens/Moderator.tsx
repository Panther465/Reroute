import { useQuery } from '@tanstack/react-query'
import * as Tabs from '@radix-ui/react-tabs'
import { Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Navigate, useOutletContext } from 'react-router'
import { api, ApiError, apiBase } from '@/api/client'
import { queryClient, useQueue, useRaastaRoute } from '@/api/queries'
import type { Contribution, ContributionDecision, FareReport, VehicleType } from '@/api/types'
import { BackButton, useBack } from '@/components/BackButton'
import { LazyMap } from '@/components/LazyMap'
import { MODE_META, ModeIcon, modeTextClass } from '@/components/icons'
import { Button, buttonClass } from '@/components/ui/Button'
import { ChipGroup, Segmented } from '@/components/ui/Choice'
import { Field } from '@/components/ui/Field'
import { EmptyState, ErrorState, LoadingRegion, Skeleton } from '@/components/ui/States'
import { Tag } from '@/components/ui/Tag'
import { rupees } from '@/lib/format'
import { routeLine, type LngLat } from '@/lib/geo'
import { useDocumentTitle, useIsDesktop } from '@/lib/hooks'
import { showToast } from '@/lib/store'


type Filter = 'waiting' | 'stale' | 'verified' | 'rejected'
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'waiting', label: 'Waiting' },
  { value: 'verified', label: 'Verified' },
  { value: 'stale', label: 'Stale' },
  { value: 'rejected', label: 'Rejected' },
]
const EMPTY: Record<Filter, string> = {
  waiting: 'Nothing waiting. New routes appear here when riders submit them.',
  verified: 'No verified routes yet.',
  stale: 'No stale routes. Every verified route was confirmed recently.',
  rejected: 'No rejected routes.',
}

function routeName(c: Contribution) {
  const stands = c.route?.stands ?? []
  return stands.length >= 2 ? `${stands[0].name} to ${stands[stands.length - 1].name}` : 'New route'
}

function sourceLabel(c: Contribution) {
  return c.kind === 'gps_ride' ? 'Recorded ride' : c.kind === 'freshness_check' ? 'Freshness check' : 'Tapped stands'
}

function when(iso: string) {
  const h = Math.floor((Date.now() - Date.parse(iso)) / 3_600_000)
  if (h < 1) return 'Just now'
  if (h < 24) return `${h} h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'Yesterday' : `${d} days ago`
}

function StatusLabel({ c }: { c: Contribution }) {
  if (c.kind === 'freshness_check' && c.status === 'waiting') return <Tag tone="red">Stale</Tag>
  const tone = c.status === 'verified' || c.status === 'merged' ? 'green' : c.status === 'rejected' ? 'red' : 'sunken'
  return <Tag tone={tone}>{c.status === 'merged' ? 'Verified by a second rider' : c.status[0].toUpperCase() + c.status.slice(1)}</Tag>
}

function invalidate() {
  void queryClient.invalidateQueries({ queryKey: ['raasta'] })
}

function Panel({ c, onClose }: { c: Contribution; onClose?: () => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view')
  const [fare, setFare] = useState(String(c.route?.fareInr ?? ''))
  const [vehicle, setVehicle] = useState<VehicleType>(c.route?.vehicleType ?? 'shared_auto')
  const [reason, setReason] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const route = c.route
  const stands = route?.stands ?? []
  const points = useMemo(() => stands.map((s, i) => ({ id: s.standId, lngLat: [s.location.lng, s.location.lat] as LngLat, kind: 'stand' as const, number: i + 1, label: `${i + 1}. ${s.name}` })), [stands])
  const lines = useMemo(() => (route ? routeLine(route.routeId, (route.path.length > 1 ? route.path : stands.map((s) => s.location)).map((p) => [p.lng, p.lat] as LngLat), route.vehicleType) : []), [route, stands])

  const decide = async (body: ContributionDecision, toast: string) => {
    setBusy(true)
    try {
      await api.patch(`/v1/raasta/contributions/${c.contributionId}`, body)
      invalidate()
      setMode('view')
      showToast({ title: toast })
      onClose?.()
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't save the decision. Try again." })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex items-start gap-2">
        {onClose && <BackButton onClick={onClose} label="Back to the list" />}
        <div>
          <h2 className="t-display-2 text-ink">{routeName(c)}</h2>
          <p className="mt-1 t-small text-ink-2">
            {sourceLabel(c)}, {when(c.createdAt).toLowerCase()}
          </p>
          <div className="mt-2 flex gap-2">
            <StatusLabel c={c} />
            {route?.sample && <Tag tone="grey-outline">Sample route</Tag>}
          </div>
        </div>
      </header>
      {route && (
        <LazyMap key={c.contributionId} lines={lines} points={points} label={`Map preview of ${routeName(c)}`} className="h-56" />
      )}
      <section aria-label="Stands">
        <h3 className="t-title text-ink">Stands</h3>
        <ol className="mt-2 flex flex-col gap-2">
          {stands.map((s, i) => (
            <li key={s.standId} className="flex items-center gap-3">
              <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-green t-caption text-on-green">
                {i + 1}
              </span>
              <span className="t-body text-ink">{s.name}</span>
            </li>
          ))}
        </ol>
      </section>
      {route && (
        <p className="flex items-center gap-2 t-body text-ink">
          <ModeIcon mode={route.vehicleType} className={modeTextClass(route.vehicleType)} />
          {MODE_META[route.vehicleType].label}, {rupees(route.fareInr)} a person, about every {route.frequencyMin} min, {route.firstTrip} to {route.lastTrip}
        </p>
      )}
      {c.rejectReason && <p className="t-small text-red-ink">Rejected: {c.rejectReason}</p>}

      {mode === 'edit' && (
        <div className="flex flex-col gap-4 rounded-card border border-line p-4">
          <Segmented<VehicleType>
            label="Vehicle"
            value={vehicle}
            onChange={setVehicle}
            options={[
              { value: 'shared_auto', label: 'Shared auto' },
              { value: 'e_rickshaw', label: 'E-rickshaw' },
              { value: 'tempo', label: 'Tempo' },
            ]}
          />
          <Field label="Fare, in rupees" type="number" inputMode="numeric" value={fare} onChange={(e) => setFare(e.target.value)} />
          <div className="flex gap-3">
            <Button
              loading={busy}
              onClick={() => {
                const n = Number(fare)
                if (!Number.isInteger(n) || n < 0 || n > 2000) return showToast({ title: 'Enter a fare between ₹0 and ₹2,000.' })
                void decide({ action: 'edit', fareInr: n, vehicleType: vehicle }, 'Changes saved.')
              }}
            >
              Save changes
            </Button>
            <Button variant="tertiary" onClick={() => setMode('view')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === 'reject' && (
        <div className="flex flex-col gap-4 rounded-card border border-line p-4">
          <p className="t-title text-ink">Why are you rejecting it?</p>
          <ChipGroup
            legend="Reason"
            name="reason"
            value={reason}
            onChange={setReason}
            options={[
              { value: 'Stands are in the wrong place.', label: 'Wrong stands' },
              { value: 'The fare looks wrong.', label: 'Fare looks wrong' },
              { value: 'This route already exists.', label: 'Duplicate' },
              { value: 'other', label: 'Other' },
            ]}
          />
          {reason === 'other' && <Field label="Reason" value={note} onChange={(e) => setNote(e.target.value)} />}
          <div className="flex gap-3">
            <Button variant="destructive" loading={busy} disabled={!reason || (reason === 'other' && note.trim().length < 3)} onClick={() => void decide({ action: 'reject', reason: reason === 'other' ? note.trim() : reason! }, 'Route rejected. The rider sees your reason.')}>
              Reject the route
            </Button>
            <Button variant="tertiary" onClick={() => setMode('view')}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {mode === 'view' && c.status === 'waiting' && (
        <div className="flex flex-wrap gap-3">
          <Button loading={busy} onClick={() => void decide({ action: 'approve' }, 'Route approved. It now shows as verified.')}>
            Approve
          </Button>
          <Button variant="secondary" onClick={() => setMode('edit')}>
            Edit
          </Button>
          <Button variant="destructive" onClick={() => setMode('reject')}>
            Reject
          </Button>
        </div>
      )}
    </div>
  )
}

/** A fare report names its route by its stands, not its ID. */
function FareReportRow({ r, onDecide }: { r: FareReport; onDecide: (id: string, action: 'accept' | 'reject') => Promise<void> }) {
  const route = useRaastaRoute(r.routeId)
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const stands = route.data?.stands ?? []
  const name = stands.length >= 2 ? `${stands[0].name} to ${stands[stands.length - 1].name}` : route.isPending ? 'Loading the route…' : 'A route no longer on Raasta'
  const decide = async (action: 'accept' | 'reject') => {
    setBusy(action)
    try {
      await onDecide(r.fareReportId, action)
    } finally {
      setBusy(null)
    }
  }
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block t-title text-ink">
          {rupees(r.fareInr)} on {name}
        </span>
        <span className="block t-small text-muted">
          {route.data ? `Now ${rupees(route.data.fareInr)}, ` : ''}
          {when(r.at).toLowerCase()}
        </span>
      </span>
      <Button size="md" loading={busy === 'accept'} disabled={busy !== null} onClick={() => void decide('accept')}>
        Accept
      </Button>
      <Button size="md" variant="destructive" loading={busy === 'reject'} disabled={busy !== null} onClick={() => void decide('reject')}>
        Reject
      </Button>
    </li>
  )
}

function FareReports() {
  const q = useQuery({ queryKey: ['raasta', 'fare-reports'], queryFn: () => api.get<{ items: FareReport[] }>('/v1/raasta/fare-reports', { query: { status: 'waiting', limit: 50 } }) })
  const decide = async (id: string, action: 'accept' | 'reject') => {
    try {
      await api.patch(`/v1/raasta/fare-reports/${id}`, { action })
      invalidate()
      showToast({ title: action === 'accept' ? 'Fare accepted.' : 'Fare report rejected.' })
    } catch (err) {
      showToast({ title: err instanceof ApiError ? err.message : "Couldn't save that. Try again." })
    }
  }
  if (q.isPending) return <Skeleton className="h-24 w-full rounded-card" />
  if (q.isError) return <ErrorState message="Couldn't load fare reports. Check your connection and try again." onRetry={() => q.refetch()} />
  if (!q.data.items.length) return <p className="t-body text-ink-2">No fare reports waiting.</p>
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
      {q.data.items.map((r) => (
        <FareReportRow key={r.fareReportId} r={r} onDecide={decide} />
      ))}
    </ul>
  )
}

export default function Moderator() {
  const { moderator } = useOutletContext<{ moderator: boolean }>()
  const desktop = useIsDesktop()
  const back = useBack('/me')
  const [filter, setFilter] = useState<Filter>('waiting')
  const [selected, setSelected] = useState<string | null>(null)
  const apiStatus = filter === 'stale' ? 'waiting' : filter
  const q = useQueue(apiStatus, moderator)
  const verified = useQueue('merged', moderator && filter === 'verified')
  useDocumentTitle('Route checks')
  if (!moderator) return <Navigate to="/me" replace />
  const all = [...(q.data?.items ?? []), ...(filter === 'verified' ? (verified.data?.items ?? []) : [])]
  const rows = all.filter((c) => (filter === 'stale' ? c.kind === 'freshness_check' : filter === 'waiting' ? c.kind !== 'freshness_check' : true))
  const sel = rows.find((c) => c.contributionId === selected) ?? null

  const body = q.isPending ? (
    <LoadingRegion label="Loading the queue">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="mt-3 h-14 w-full" />
      ))}
    </LoadingRegion>
  ) : q.isError ? (
    <ErrorState message="Couldn't load the queue. Check your connection and try again." onRetry={() => q.refetch()} />
  ) : rows.length === 0 ? (
    <EmptyState title={`No ${filter} routes`} body={EMPTY[filter]} />
  ) : desktop ? (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{FILTERS.find((f) => f.value === filter)!.label} routes</caption>
        <thead>
          <tr className="border-b border-line t-caption text-ink-2">
            {['Route', 'Submitted by', 'Source', 'Stands', 'Fare', 'Status', 'Submitted'].map((h) => (
              <th key={h} scope="col" className={`px-4 py-3 ${h === 'Fare' || h === 'Stands' ? 'text-right' : ''}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.contributionId} className={`border-b border-line last:border-b-0 ${selected === c.contributionId ? 'bg-green-tint' : '[@media(hover:hover)]:hover:bg-sunken/60'}`}>
              <td className="px-4 py-2">
                <button type="button" aria-pressed={selected === c.contributionId} onClick={() => setSelected(c.contributionId)} className="flex min-h-12 items-center gap-2 text-left t-title text-ink">
                  {c.route && <ModeIcon mode={c.route.vehicleType} className={modeTextClass(c.route.vehicleType)} />}
                  {routeName(c)}
                </button>
              </td>
              <td className="px-4 py-2 t-body text-ink-2">Rider {c.contributorId?.slice(-4) ?? ''}</td>
              <td className="px-4 py-2 t-body text-ink-2">{sourceLabel(c)}</td>
              <td className="px-4 py-2 text-right t-body text-ink tnum">{c.route?.stands.length ?? 0}</td>
              <td className="px-4 py-2 text-right t-body text-ink tnum">{c.route ? rupees(c.route.fareInr) : ''}</td>
              <td className="px-4 py-2">
                <StatusLabel c={c} />
              </td>
              <td className="px-4 py-2 t-body text-ink-2">{when(c.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
      {rows.map((c) => (
        <li key={c.contributionId}>
          <button type="button" onClick={() => setSelected(c.contributionId)} className="flex w-full items-start gap-3 px-4 py-4 text-left">
            {c.route && <ModeIcon mode={c.route.vehicleType} size={24} className={`mt-0.5 shrink-0 ${modeTextClass(c.route.vehicleType)}`} />}
            <span className="min-w-0 flex-1">
              <span className="block t-title text-ink">{routeName(c)}</span>
              <span className="block t-small text-ink-2">
                {sourceLabel(c)}, {c.route?.stands.length ?? 0} stands{c.route ? `, ${rupees(c.route.fareInr)}` : ''}
              </span>
              <span className="block t-small text-muted">{when(c.createdAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )

  if (!desktop && sel) {
    return (
      <div className="mx-auto max-w-[560px] px-5 pb-10 pt-4">
        <Panel key={sel.contributionId} c={sel} onClose={() => setSelected(null)} />
      </div>
    )
  }

  return (
    <div className={`mx-auto px-5 pb-10 pt-4 lg:px-8 lg:pt-8 ${desktop ? 'max-w-[1440px]' : 'max-w-[560px]'}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-2">
          <BackButton onClick={back} className="lg:hidden" />
          <div className="pt-1">
            <h1 tabIndex={-1} className="t-display-1 text-ink">
              Route checks
            </h1>
            <p className="mt-1 t-body text-ink-2">Check rider routes before they show as verified.</p>
          </div>
        </div>
        <a href={`${apiBase}/v1/raasta/cities/bengaluru/gtfs.zip`} download className={buttonClass('secondary')}>
          <Download size={20} strokeWidth={1.75} aria-hidden="true" />
          <span>Download verified routes (GTFS)</span>
        </a>
      </header>
      <Tabs.Root
        value={filter}
        onValueChange={(v) => {
          setFilter(v as Filter)
          setSelected(null)
        }}
        className="mt-6"
      >
        <Tabs.List aria-label="Filter routes" className="flex gap-1 overflow-x-auto border-b border-line">
          {FILTERS.map((f) => (
            <Tabs.Trigger key={f.value} value={f.value} className="relative flex min-h-12 items-center gap-2 px-4 t-title text-ink-2 data-[state=active]:text-green-ink data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:bottom-0 data-[state=active]:after:h-[3px] data-[state=active]:after:rounded-t-full data-[state=active]:after:bg-green">
              {f.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value={filter} className="mt-4 outline-none">
          {desktop ? (
            <div className={`grid gap-6 ${sel ? 'grid-cols-[minmax(0,1fr)_420px]' : ''}`}>
              <div>{body}</div>
              {sel && (
                <aside aria-label="Route detail" className="rounded-card border border-line bg-surface p-6">
                  <Panel key={sel.contributionId} c={sel} />
                </aside>
              )}
            </div>
          ) : (
            body
          )}
        </Tabs.Content>
      </Tabs.Root>
      <section className="mt-10" aria-labelledby="fares-h">
        <h2 id="fares-h" className="mb-3 t-display-2 text-ink">
          Fare reports
        </h2>
        <FareReports />
      </section>
    </div>
  )
}
