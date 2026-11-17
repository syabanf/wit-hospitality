import { daysBetween, type IsoDate } from '@/lib/dates'
import { findConflicts, type Booking, type UnitBlock } from './booking'
import type { HousekeepingState } from './maintenance'
import { unitKindOf, type Catalog, type Unit } from './property'

/**
 * The room rack: what each hotel room is doing on a date, from the stays and the housekeeping
 * board. Contract: api/docs/contracts/hotel-desk-contract.md sections 1 and 2.
 */

export type Occupancy = 'vacant' | 'arriving' | 'in_house' | 'due_out' | 'departed'
export const OCCUPANCIES: readonly Occupancy[] = ['vacant', 'arriving', 'in_house', 'due_out', 'departed']
export const OCCUPANCY_LABEL: Record<Occupancy, string> = { vacant: 'Vacant', arriving: 'Arriving', in_house: 'In house', due_out: 'Due out', departed: 'Departed' }

/** The rack's names for the board's states. */
export const RACK_HK_LABEL: Record<HousekeepingState, string> = { ready: 'Clean', inspected: 'Inspected', cleaning: 'Cleaning', dirty: 'Dirty', out_of_order: 'Out of service' }

type Stay = Pick<Booking, 'id' | 'status' | 'checkIn' | 'checkOut' | 'checkedOutOn' | 'unitId' | 'unitAssigned'>

export interface RoomOccupancy<T extends Stay = Stay> {
  occupancy: Occupancy
  /** The stay the room shows: the guest in house or due out, else the arrival, else the departure. */
  stay: T | null
  /** An arrival on the same day behind a guest in house or due out. */
  next: T | null
}

/**
 * roomOccupancy. A stay on a date after today reads by its dates: confirmed over the night is in
 * house, ending that day is due out, so the rack doubles as a forecast.
 */
export function roomOccupancy<T extends Stay>(unitId: string, date: IsoDate, today: IsoDate, stays: readonly T[]): RoomOccupancy<T> {
  const mine = stays.filter((b) => b.unitAssigned && b.unitId === unitId)
  const future = date > today
  const live = (b: T) => b.status === 'checked_in' || (future && b.status === 'confirmed')
  const inHouse = mine.find((b) => live(b) && b.checkIn <= date && date < b.checkOut && !(future && b.status === 'confirmed' && b.checkIn === date))
  const dueOut = mine.find((b) => live(b) && b.checkOut === date)
  const arriving = mine.find((b) => b.status === 'confirmed' && b.checkIn === date)
  const departed = mine.find((b) => b.status === 'checked_out' && (b.checkOut === date || b.checkedOutOn === date))
  if (inHouse) return { occupancy: 'in_house', stay: inHouse, next: arriving ?? null }
  if (dueOut) return { occupancy: 'due_out', stay: dueOut, next: arriving ?? null }
  if (arriving) return { occupancy: 'arriving', stay: arriving, next: null }
  if (departed) return { occupancy: 'departed', stay: departed, next: null }
  return { occupancy: 'vacant', stay: null, next: null }
}

/** Hotel rooms: the room-kind units of a property, by code. */
export const hotelRooms = (catalog: Catalog, villaId: string): Unit[] =>
  catalog.units.filter((u) => u.villaId === villaId && u.status !== 'inactive' && unitKindOf(catalog, u.id) === 'room').sort((a, b) => a.code.localeCompare(b.code))

/** How ready a room is for a guest; lower is better. */
const READINESS: Record<HousekeepingState, number> = { ready: 0, inspected: 0, cleaning: 1, dirty: 2, out_of_order: 3 }

export interface AssignChoice {
  unit: Unit
  state: HousekeepingState
  /** Set when housekeeping has not released the room; it stays selectable. */
  warning: string | null
}

/**
 * assignChoices: the active rooms of the stay's room type free for its nights, ready and inspected
 * first, then cleaning, then dirty, by code inside each. Out of service rooms are left out.
 */
export function assignChoices(b: Booking, catalog: Catalog, bookings: readonly Booking[], blocks: readonly UnitBlock[], stateOf: (unitId: string) => HousekeepingState): AssignChoice[] {
  const groupId = catalog.unit(b.unitId).groupId
  if (!groupId) return []
  return catalog.units
    .filter((u) => u.groupId === groupId && u.status === 'active' && findConflicts(u.id, b.checkIn, b.checkOut, bookings, blocks, b.id).length === 0)
    .map((unit) => {
      const state = stateOf(unit.id)
      return { unit, state, warning: READINESS[state] === 0 ? null : `${unit.code} is ${state.replace('_', ' ')}; housekeeping has not released it.` }
    })
    .filter((c) => c.state !== 'out_of_order')
    .sort((a, b) => READINESS[a.state] - READINESS[b.state] || a.unit.code.localeCompare(b.unit.code))
}

export type MoveRate = 'keep' | 'reprice'
export const MOVE_RATE_LABEL: Record<MoveRate, string> = { keep: 'Keep the rate (free upgrade)', reprice: 'Reprice the remaining nights' }

/** Whether a stay in `current` may move to `target`: the same interchangeable type, or for a hotel room any other room of the property. */
export function moveCandidate(catalog: Catalog, current: Unit, target: Unit): boolean {
  if (target.id === current.id) return false
  const group = current.groupId ? catalog.groups.find((g) => g.id === current.groupId) : undefined
  if (group?.interchangeable && target.groupId === group.id) return true
  return unitKindOf(catalog, current.id) === 'room' && unitKindOf(catalog, target.id) === 'room' && target.villaId === current.villaId
}

/** The active rooms a stay may move to that are free for its nights. */
export const moveTargets = (b: Booking, catalog: Catalog, bookings: readonly Booking[], blocks: readonly UnitBlock[]): Unit[] => {
  const current = catalog.unit(b.unitId)
  return catalog.units.filter((u) => u.status === 'active' && moveCandidate(catalog, current, u) && findConflicts(u.id, b.checkIn, b.checkOut, bookings, blocks, b.id).length === 0)
}

/** The first night a reprice move prices again: nights the audit posted and nights before today keep their price. */
export const repriceFrom = (b: Pick<Booking, 'checkIn' | 'nightsPosted'>, today: IsoDate) => Math.max(b.nightsPosted?.length ?? 0, daysBetween(b.checkIn, today), 0)
