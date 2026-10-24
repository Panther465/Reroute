// Places travellers add themselves: each kind's name and icon, what a place's status means, and saving or
// deleting one with the map and place search kept in step.
import { Bus, Camera, Hotel, MapPin, ShoppingBag, UtensilsCrossed, type LucideIcon } from 'lucide-react'
import { api } from '@/api/client'
import { keys, queryClient } from '@/api/queries'
import type { Body, OwnPlace, OwnPlaceIn, PlaceCategory } from '@/api/types'
import type { TagTone } from '@/components/ui/Tag'

export const CATEGORIES: { value: PlaceCategory; label: string; Icon: LucideIcon }[] = [
  { value: 'food', label: 'Food', Icon: UtensilsCrossed },
  { value: 'stay', label: 'Stay', Icon: Hotel },
  { value: 'sight', label: 'Sight', Icon: Camera },
  { value: 'shop', label: 'Shop', Icon: ShoppingBag },
  { value: 'transit', label: 'Transit', Icon: Bus },
  { value: 'other', label: 'Other', Icon: MapPin },
]

export function categoryOf(category: PlaceCategory | null | undefined) {
  return CATEGORIES.find((c) => c.value === category) ?? CATEGORIES[CATEGORIES.length - 1]
}

/** What a place's status means to the traveller who added it. */
export const STATUS: Record<OwnPlace['status'], { label: string; tone: TagTone }> = {
  private: { label: 'Only you', tone: 'grey-outline' },
  pending: { label: 'Waiting for a moderator', tone: 'sunken' },
  approved: { label: 'Shared with everyone', tone: 'green' },
  rejected: { label: 'Not shared', tone: 'red' },
}

export const NAME_MAX = 80
export const NOTE_MAX = 280

/** Search in the place's city finds it (or no longer does), and the map's pins follow. */
function refresh(city: string) {
  void queryClient.invalidateQueries({ queryKey: keys.ownPlaces(city) })
  void queryClient.invalidateQueries({ queryKey: ['places', city] })
}

export async function saveOwnPlace(body: Body<OwnPlaceIn>, idempotencyKey: string): Promise<OwnPlace> {
  const place = await api.post<OwnPlace>('/v1/me/places', body, { idempotencyKey })
  // The pin shows at once, without waiting for the list to come back.
  queryClient.setQueryData<OwnPlace[]>(keys.ownPlaces(place.citySlug), (list) => list && [place, ...list.filter((p) => p.placeId !== place.placeId)])
  refresh(place.citySlug)
  return place
}

export async function deleteOwnPlace(place: OwnPlace) {
  await api.delete(`/v1/me/places/${place.placeId}`)
  queryClient.setQueryData<OwnPlace[]>(keys.ownPlaces(place.citySlug), (list) => list?.filter((p) => p.placeId !== place.placeId))
  refresh(place.citySlug)
}
