import { MapPin, MapPinPlus, Search, Star } from 'lucide-react'
import { lazy, Suspense, useEffect, useState } from 'react'
import { usePlaceSearch } from '@/api/queries'
import type { Place } from '@/api/types'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import type { LngLat } from '@/lib/geo'
import { placeSearchError } from '@/lib/placeSearch'

// Adding a place of your own loads the first time someone does it.
const AddPlaceSheet = lazy(() => import('./OwnPlaceSheets').then((m) => ({ default: m.AddPlaceSheet })))

function PlaceRow({ place, onChoose }: { place: Place; onChoose: () => void }) {
  const Icon = place.mine ? Star : MapPin
  const whose = place.mine ? ', your place' : place.category ? ', added by a traveller' : place.sample ? ', sample place' : ''
  return (
    <li>
      <button type="button" onClick={onChoose} className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left [@media(hover:hover)]:hover:bg-sunken">
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" className={`shrink-0 ${place.mine ? 'text-blue' : 'text-muted'}`} />
        <span>
          <span className="block t-body text-ink">{place.name}</span>
          <span className="block t-small text-muted">
            {place.area}
            {whose}
          </span>
        </span>
      </button>
    </li>
  )
}

/**
 * Search for a place (your own first, then known places, then OpenStreetMap), or show the one chosen with
 * "Change". One that isn't there can be added as your own place, and is chosen once it's saved.
 */
export function PlacePicker({
  label,
  city,
  cityName,
  near,
  value,
  onChange,
  error,
  hint = 'Search by area or building',
}: {
  label: string
  city: string
  /** For adding a place of your own: the city's name, and where its map opens (the stay, or the city's centre). */
  cityName?: string
  near?: LngLat | null
  value: Place | null
  onChange: (p: Place | null) => void
  error?: string
  hint?: string
}) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [adding, setAdding] = useState(false)
  const [addLoaded, setAddLoaded] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q), 300)
    return () => clearTimeout(id)
  }, [q])
  const search = usePlaceSearch(debounced, city)
  const canAdd = !!cityName && !!near
  const searched = debounced.trim().length >= 2
  const mine = (search.data ?? []).filter((p) => p.mine)
  const others = (search.data ?? []).filter((p) => !p.mine)

  return (
    <div>
      {value ? (
        <>
          <p className="mb-2 t-title text-ink">{label}</p>
          <div className={`flex items-center gap-3 rounded-control border-2 px-4 py-2 ${value.mine ? 'border-blue bg-blue-tint' : 'border-green bg-green-tint'}`}>
            {value.mine ? (
              <Star size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-blue" />
            ) : (
              <MapPin size={20} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-green-ink" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block t-title text-ink">{value.name}</span>
              <span className="block t-small text-ink-2">
                {value.area}
                {value.mine ? ', your place' : ''}
              </span>
            </span>
            <Button variant="tertiary" size="md" onClick={() => onChange(null)}>
              Change
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field label={label} type="search" value={q} onChange={(e) => setQ(e.target.value)} error={error} autoComplete="off" hint={hint} trailing={<Search size={20} strokeWidth={1.75} aria-hidden="true" className="mr-3 text-muted" />} />
          {searched && (
            <ul aria-label="Places found" aria-busy={search.isFetching} className="mt-2 divide-y divide-line overflow-hidden rounded-control border border-line bg-surface">
              {search.isPending && <li className="px-4 py-3 t-small text-ink-2">Searching…</li>}
              {search.isError && <li className="px-4 py-3 t-small text-ink-2">{placeSearchError(search.error)}</li>}
              {search.data?.length === 0 && <li className="px-4 py-3 t-small text-ink-2">No places match. Try the area name, like Koramangala.</li>}
              {mine.length > 0 && (
                <li aria-hidden="true" className="bg-sunken px-4 py-1.5 t-caption text-ink-2">
                  Your places
                </li>
              )}
              {mine.map((p) => (
                <PlaceRow key={p.placeId} place={p} onChoose={() => onChange(p)} />
              ))}
              {mine.length > 0 && others.length > 0 && (
                <li aria-hidden="true" className="bg-sunken px-4 py-1.5 t-caption text-ink-2">
                  Other places
                </li>
              )}
              {others.map((p) => (
                <PlaceRow key={p.placeId} place={p} onChoose={() => onChange(p)} />
              ))}
            </ul>
          )}
          {canAdd && searched && !search.isPending && (
            <Button
              variant="tertiary"
              size="md"
              className="-ml-2 mt-2"
              icon={<MapPinPlus size={20} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => {
                setAddLoaded(true)
                setAdding(true)
              }}
            >
              Not here? Add it as your own place
            </Button>
          )}
        </>
      )}
      {/* Outside both views, so the sheet closes over the place it just chose. */}
      {addLoaded && canAdd && (
        <Suspense fallback={null}>
          <AddPlaceSheet open={adding} onOpenChange={setAdding} city={city} cityName={cityName ?? ''} at={null} near={near} initialName={q.trim().slice(0, 80)} onSaved={onChange} />
        </Suspense>
      )}
    </div>
  )
}
