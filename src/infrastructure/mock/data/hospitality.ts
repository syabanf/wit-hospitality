import type { BookingStatus } from '@/domain/booking'
import type { GuestPreferences, ServiceWindow } from '@/domain/hospitality'
import type { UnitKind } from '@/domain/property'

/** What a few guests asked for; `nth` counts the stays of that status and kind by arrival. */
export interface HospitalitySeed {
  status: BookingStatus
  kind: UnitKind
  nth: number
  preferences: Partial<GuestPreferences>
  window?: ServiceWindow
}

export const HOSPITALITY_SEEDS: readonly HospitalitySeed[] = [
  // The demo's do-not-disturb stay: a honeymoon couple in a villa.
  { status: 'checked_in', kind: 'villa', nth: 0, preferences: { breakfastTime: '09:30', setups: ['romantic_dinner'], notes: 'Honeymoon; please keep it quiet.' }, window: { mode: 'dnd', from: '', to: '' } },
  { status: 'checked_in', kind: 'villa', nth: 1, preferences: { breakfastTime: '08:00', dietary: 'Vegetarian, no peanuts', setups: ['floating_breakfast'] }, window: { mode: 'window', from: '09:00', to: '11:00' } },
  { status: 'confirmed', kind: 'villa', nth: 0, preferences: { breakfastTime: '07:30', dietary: 'One child is lactose intolerant', setups: ['bbq', 'baby_cot'], arrivalTime: '16:00', notes: 'Two children, 3 and 6.' } },
  { status: 'confirmed', kind: 'villa', nth: 1, preferences: { setups: ['airport_pickup'], arrivalTime: '21:30', notes: 'Flight lands at 20:40.' } },
  { status: 'confirmed', kind: 'room', nth: 0, preferences: { arrivalTime: '16:30', notes: 'Upstairs room if one is free.' } },
]
