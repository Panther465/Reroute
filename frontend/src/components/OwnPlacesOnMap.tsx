import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { useOwnPlaces } from '@/api/queries'
import type { OwnPlace, Trip } from '@/api/types'
import type { MapPoint } from '@/components/MapCard'
import type { LngLat } from '@/lib/geo'
import { categoryOf } from '@/lib/ownPlaces'

// The sheets load the first time one opens, so a screen with a map stays small.
const AddPlaceSheet = lazy(() => import('./OwnPlaceSheets').then((m) => ({ default: m.AddPlaceSheet })))
const OwnPlaceSheet = lazy(() => import('./OwnPlaceSheets').then((m) => ({ default: m.OwnPlaceSheet })))

/**
 * The traveller's own places on a trip's map: a blue pin for each (a tap opens it, to see or delete it), and
 * press and hold, or "Add a place", to add one. Give the map `points` and `onLongPress`, and render `sheets`.
 * `shown`: places the map already pins as stops of the day, which get no second pin.
 */
export function useOwnPlacesOnMap(trip: Trip | undefined, shown: readonly string[] = []): { points: MapPoint[]; onLongPress: (at: LngLat) => void; sheets: ReactNode } {
  const q = useOwnPlaces(trip?.citySlug)
  const [adding, setAdding] = useState<LngLat | null>(null)
  const [viewing, setViewing] = useState<OwnPlace | null>(null)
  const [loaded, setLoaded] = useState(false)
  const shownKey = shown.join('|')
  const points = useMemo<MapPoint[]>(
    () =>
      (q.data ?? [])
        .filter((p) => !shown.includes(p.placeId))
        .map((p) => ({
          id: `own-${p.placeId}`,
          lngLat: [p.lng, p.lat],
          kind: 'saved',
          label: `${p.name}, your place`,
          icon: categoryOf(p.category).Icon,
          caption: p.name,
          onClick: () => {
            setLoaded(true)
            setViewing(p)
          },
        })),
    // shownKey stands for `shown` by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data, shownKey],
  )
  const onLongPress = (at: LngLat) => {
    setLoaded(true)
    setAdding(at)
  }
  const sheets = loaded && trip && (
    <Suspense fallback={null}>
      <AddPlaceSheet open={!!adding} onOpenChange={(o) => !o && setAdding(null)} city={trip.citySlug} cityName={trip.cityName} at={adding} />
      <OwnPlaceSheet place={viewing} onOpenChange={(o) => !o && setViewing(null)} />
    </Suspense>
  )
  return { points, onLongPress, sheets }
}
