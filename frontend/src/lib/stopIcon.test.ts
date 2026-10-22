import { Banknote, Hotel, MapPin, TrainFront, UtensilsCrossed } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { stopIcon } from './stopIcon'

describe('stopIcon', () => {
  it('guesses a stop from its title: the meal before who it is with, a pin when nothing fits', () => {
    expect(stopIcon('Bank')).toBe(Banknote)
    expect(stopIcon('Dinner with a client')).toBe(UtensilsCrossed)
    expect(stopIcon('Train home')).toBe(TrainFront)
    expect(stopIcon('Pick up the parcel? No: a riddle')).not.toBe(MapPin)
    expect(stopIcon('Something else entirely')).toBe(MapPin)
  })

  it('draws the place of stay as a hotel at both ends of the day', () => {
    expect(stopIcon('Meeting', 'start')).toBe(Hotel)
    expect(stopIcon('Meeting', 'end')).toBe(Hotel)
  })
})
