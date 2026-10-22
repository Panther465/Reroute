// Simulated booking partners. The names are invented on purpose: nothing here talks to a real railway,
// airline or ride app, and connecting one only flips a switch on this phone.
import { Bike, Car, Plane, TrainFront, type LucideIcon } from 'lucide-react'
import { AutoRickshaw } from '@/components/icons'
import { getState, setState, useStore } from '@/lib/store'

export type PartnerId = 'ridenow' | 'autogo' | 'zipbike' | 'railgo' | 'skyhop'

export interface Partner {
  id: PartnerId
  name: string
  what: string
  /** What connecting lets Reroute do, in the consent sheet. */
  lets: string
  Icon: LucideIcon | typeof AutoRickshaw
}

export const PARTNERS: Partner[] = [
  { id: 'ridenow', name: 'RideNow', what: 'Cabs', lets: 'book cabs for the legs of your day', Icon: Car },
  { id: 'autogo', name: 'AutoGo', what: 'Autos', lets: 'book auto rickshaws for short legs', Icon: AutoRickshaw },
  { id: 'zipbike', name: 'ZipBike', what: 'Bike taxis', lets: 'book bike taxis when you travel light', Icon: Bike },
  { id: 'railgo', name: 'RailGo', what: 'Trains', lets: 'search trains and book tickets', Icon: TrainFront },
  { id: 'skyhop', name: 'SkyHop', what: 'Flights', lets: 'search flights and book tickets', Icon: Plane },
]

export const partner = (id: string) => PARTNERS.find((p) => p.id === id)

export function useConnected(id: PartnerId) {
  return useStore((s) => !!s.connections[id])
}

export function useConnections() {
  return useStore((s) => s.connections)
}

export function connect(id: PartnerId) {
  setState({ connections: { ...getState().connections, [id]: true } })
}

export function disconnect(id: PartnerId) {
  setState({ connections: { ...getState().connections, [id]: false } })
}

/** The demo account comes with every partner connected, once; a new account starts with none. */
export function connectAllOnce() {
  if (Object.keys(getState().connections).length === 0) setState({ connections: Object.fromEntries(PARTNERS.map((p) => [p.id, true])) })
}
