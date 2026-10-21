// API-shaped sample data for tests: the golden plan version 1 from the project brief, section 16.
import type { Leg, Place, Task, Trip } from '@/api/types'

const D = '2026-10-14'
const iso = (hm: string, day = D) => `${day}T${hm}:00+05:30`

export const places: Record<string, Place> = {
  hotel: { placeId: 'hotel-majestic', name: 'Hotel near Majestic', area: 'Majestic', lng: 77.5713, lat: 12.9767, sample: true },
  wf: { placeId: 'whitefield-office', name: 'ITPL Road office', area: 'Whitefield', lng: 77.7318, lat: 12.9855, sample: true },
  kor: { placeId: 'koramangala-bank', name: 'Bank, 80 Feet Road', area: 'Koramangala', lng: 77.6195, lat: 12.9352, sample: true },
  jay: { placeId: 'jayanagar-office', name: 'University admin office', area: 'Jayanagar', lng: 77.5838, lat: 12.9255, sample: true },
  ksr: { placeId: 'ksr-station', name: 'KSR Bengaluru City station', area: 'KSR Bengaluru', lng: 77.5694, lat: 12.9779, sample: true },
}

function task(id: string, title: string, place: Place, extra: Partial<Task>): Task {
  return { taskId: id, tripId: 'trip-001', title, placeId: place.placeId, place, durationMin: 60, fixedStart: null, window: null, priority: 1, state: 'planned', hoursUnknown: false, day: D, ...extra }
}

export function tasks(): Task[] {
  return [
    task('task-meet', 'Meeting', places.wf, { fixedStart: iso('10:00') }),
    task('task-bank', 'Bank', places.kor, { durationMin: 150, window: { opensAt: '10:00', closesAt: '16:00' } }),
    task('task-office', 'University office', places.jay, { durationMin: 45, window: { opensAt: '10:00', closesAt: '17:00' } }),
    task('task-train', 'Train home', places.ksr, { durationMin: 30, fixedStart: iso('21:00', '2026-10-15'), day: '2026-10-15' }),
  ]
}

function leg(seq: number, taskId: string | null, from: Place, to: Place, label: string, segments: Leg['segments'], leave: string, arrive: string, start: string, end: string, fare: number, raasta = false): Leg {
  const travel = segments.reduce((n, s) => n + s.minutes, 0)
  return {
    seq,
    taskId,
    mode: segments.reduce((a, b) => (b.minutes > a.minutes ? b : a)).mode,
    label,
    segments,
    fromPlaceId: from.placeId,
    toPlaceId: to.placeId,
    leaveBy: iso(leave),
    arriveAt: iso(arrive),
    taskStart: iso(start),
    taskEnd: iso(end),
    travelMin: travel,
    waitMin: 0,
    fareInr: fare,
    optionId: `${from.placeId}-${to.placeId}`,
    transitRef: raasta ? { kind: 'raasta', refId: 'sample-kor-jay', status: 'verified' } : { kind: 'metro', refId: 'purple-line', status: null },
    extras: [],
    estimate: true,
    rough: false,
  }
}

export function planV1Legs(): Leg[] {
  return [
    leg(1, 'task-meet', places.hotel, places.wf, 'Metro, then shared auto', [{ mode: 'metro', minutes: 45 }, { mode: 'shared_auto', minutes: 15 }], '08:50', '09:50', '10:00', '11:00', 70),
    leg(2, 'task-bank', places.wf, places.kor, 'Metro, then shared auto', [{ mode: 'metro', minutes: 55 }, { mode: 'shared_auto', minutes: 25 }], '11:05', '12:25', '12:25', '14:55', 80),
    leg(3, 'task-office', places.kor, places.jay, 'Shared auto', [{ mode: 'shared_auto', minutes: 40 }], '15:00', '15:40', '15:40', '16:25', 30, true),
    leg(4, null, places.jay, places.hotel, 'Metro', [{ mode: 'metro', minutes: 20 }], '16:30', '16:50', '16:50', '16:50', 30),
  ]
}

export function goldenTrip(now = '10:55', overrides: Partial<Trip> = {}): Trip {
  return {
    tripId: 'trip-001',
    citySlug: 'bengaluru',
    cityName: 'Bengaluru',
    startDate: D,
    endDate: '2026-10-15',
    stayLabel: 'Hotel near Majestic',
    sample: true,
    utcOffset: '+05:30',
    stayPlace: places.hotel,
    tasks: tasks(),
    activePlan: {
      planId: 'plan-001',
      tripId: 'trip-001',
      day: D,
      version: 1,
      status: 'active',
      trigger: 'created',
      checkinId: null,
      inputsHash: 'x'.repeat(64),
      ruleVersion: '1.0',
      travelTimeSnapshotId: 'blr-sample',
      legs: planV1Legs(),
      doneLegs: [],
      moved: [],
      totals: { travelMin: 200, fareInr: 210, waitMin: 0 },
      reasonCodes: ['RAASTA_VERIFIED'],
      explanation: 'Planned three tasks.',
      approximate: false,
      cost: 221,
      createdAt: iso('07:30'),
    },
    openOptions: null,
    log: [],
    now: iso(now),
    clockSimulated: true,
    day: D,
    dayIndex: 1,
    dayCount: 2,
    ...overrides,
  }
}
