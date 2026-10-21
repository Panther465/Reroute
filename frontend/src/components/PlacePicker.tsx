import { MapPin, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePlaceSearch } from '@/api/queries'
import type { Place } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { placeSearchError } from '@/lib/placeSearch'

/** Search for a place (known places first, then OpenStreetMap), or show the one chosen with "Change". */
export function PlacePicker({
  label,
  city,
  value,
  onChange,
  error,
  hint = 'Search by area or building',
}: {
  label: string
  city: string
  value: Place | null
  onChange: (p: Place | null) => void
  error?: string
  hint?: string
}) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 300)
    return () => clearTimeout(id)
  }, [q])
  const search = usePlaceSearch(debounced, city)
  if (value)
    return (
      <div>
        <p className="mb-2 t-title text-ink">{label}</p>
        <div className="flex items-center gap-3 rounded-control border-2 border-green bg-green-tint px-4 py-2">
          <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-green-ink" />
          <span className="min-w-0 flex-1">
            <span className="block t-title text-ink">{value.name}</span>
            <span className="block t-small text-ink-2">{value.area}</span>
          </span>
          <Button variant="tertiary" size="md" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    )
  return (
    <div>
      <Field label={label} type="search" value={q} onChange={(e) => setQ(e.target.value)} error={error} autoComplete="off" hint={hint} trailing={<Search size={20} strokeWidth={1.75} aria-hidden="true" className="mr-3 text-muted" />} />
      {debounced.trim().length >= 2 && (
        <ul aria-label="Places found" aria-busy={search.isFetching} className="mt-2 divide-y divide-line overflow-hidden rounded-control border border-line bg-surface">
          {search.isPending && <li className="px-4 py-3 t-small text-ink-2">Searching…</li>}
          {search.isError && <li className="px-4 py-3 t-small text-ink-2">{placeSearchError(search.error)}</li>}
          {search.data?.length === 0 && <li className="px-4 py-3 t-small text-ink-2">No places match. Try the area name, like Koramangala.</li>}
          {search.data?.map((p) => (
            <li key={p.placeId}>
              <button type="button" onClick={() => onChange(p)} className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left [@media(hover:hover)]:hover:bg-sunken">
                <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
                <span>
                  <span className="block t-body text-ink">{p.name}</span>
                  <span className="block t-small text-muted">
                    {p.area}
                    {p.sample ? ', sample place' : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
