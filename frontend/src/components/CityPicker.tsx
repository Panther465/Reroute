import { Building2, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useCitySearch } from '@/api/queries'
import type { City } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'

/** The city of a trip: any city or town in India, searched by name (spelling slips are fine). */
export function CityPicker({ value, onChange }: { value: City | null; onChange: (c: City | null) => void }) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 300)
    return () => clearTimeout(id)
  }, [q])
  const search = useCitySearch(debounced)
  if (value)
    return (
      <div>
        <p className="mb-2 t-title text-ink">City</p>
        <div className="flex items-center gap-3 rounded-control border-2 border-green bg-green-tint px-4 py-2">
          <Building2 size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-green-ink" />
          <span className="min-w-0 flex-1">
            <span className="block t-title text-ink">{value.name}</span>
            <span className="block t-small text-ink-2">{value.sample ? 'Metro, shared autos and sample places' : `${value.state ? `${value.state}. ` : ''}Rough cab and walking times`}</span>
          </span>
          <Button variant="tertiary" size="md" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    )
  return (
    <div>
      <Field label="City" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" hint="Any city or town in India, like Rajpura or Pune" trailing={<Search size={20} strokeWidth={1.75} aria-hidden="true" className="mr-3 text-muted" />} />
      {debounced.trim().length >= 2 && (
        <ul aria-label="Cities found" aria-busy={search.isFetching} className="mt-2 divide-y divide-line overflow-hidden rounded-control border border-line bg-surface">
          {search.isPending && <li className="px-4 py-3 t-small text-ink-2">Searching…</li>}
          {search.isError && <li className="px-4 py-3 t-small text-ink-2">Couldn’t search right now. Try again.</li>}
          {search.data?.length === 0 && <li className="px-4 py-3 t-small text-ink-2">No city or town by that name in India.</li>}
          {search.data?.map((c) => (
            <li key={c.slug}>
              <button type="button" onClick={() => onChange(c)} className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left [@media(hover:hover)]:hover:bg-sunken">
                <Building2 size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-muted" />
                <span>
                  <span className="block t-body text-ink">{c.name}</span>
                  {c.state && <span className="block t-small text-muted">{c.state}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
