import { eachDay, type IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'
import { occupies, sellsRoomType, type Holding, type UnitBlock } from './booking'
import type { Catalog } from './property'

/**
 * Controlled overbooking. A room type that sells by type may take more stays a night than it has
 * rooms, up to its policy; a room sold room by room never does. When a night is still overbooked on
 * the arrival day, the front desk walks a guest: to a unit of another villa, or to an outside property
 * at the operator's cost.
 */

export interface OverbookPolicy {
  groupId: string
  /** Stays a night the type may sell past its rooms; 0 sells to the rooms only. */
  limit: number
}

export const MAX_OVERBOOK = 5

export const overbookLimit = (policies: readonly OverbookPolicy[], groupId: string | null | undefined) => policies.find((p) => p.groupId === groupId)?.limit ?? 0

export function validateOverbook(limit: number): string | null {
  return Number.isInteger(limit) && limit >= 0 && limit <= MAX_OVERBOOK ? null : `Enter whole stays from 0 to ${MAX_OVERBOOK}.`
}

export interface OverbookedNight {
  groupId: string
  date: IsoDate
  /** Open rooms of the type that night, less blocked ones. */
  rooms: number
  /** Stays holding the type that night, with a room or waiting for one. */
  held: number
  over: number
}

/** Nights in [from, to) where a room type holds more stays than rooms. Only room types that sell by type can get there. */
export function overbookedNights(catalog: Catalog, groupId: string, from: IsoDate, to: IsoDate, bookings: readonly Holding[], blocks: readonly UnitBlock[]): OverbookedNight[] {
  if (!sellsRoomType(catalog.groups.find((g) => g.id === groupId))) return []
  const rooms = catalog.units.filter((u) => u.groupId === groupId && u.status !== 'inactive')
  const ids = new Set(rooms.map((u) => u.id))
  const live = bookings.filter((b) => occupies(b) && ids.has(b.unitId) && b.checkIn < to && from < b.checkOut)
  return eachDay(from, to)
    .map((date) => {
      const blocked = new Set(blocks.filter((k) => ids.has(k.unitId) && k.from <= date && date < k.to).map((k) => k.unitId))
      const held = live.filter((b) => b.checkIn <= date && date < b.checkOut).length
      const open = rooms.length - blocked.size
      return { groupId, date, rooms: open, held, over: held - open }
    })
    .filter((n) => n.over > 0)
}

export type WalkDestination = 'group_villa' | 'outside'
export const WALK_DESTINATIONS: readonly WalkDestination[] = ['group_villa', 'outside']
export const WALK_DESTINATION_LABEL: Record<WalkDestination, string> = { group_villa: 'Another villa of ours', outside: 'Outside property' }

export type WalkMethod = 'cash' | 'bank_transfer'
export const WALK_METHOD_LABEL: Record<WalkMethod, string> = { cash: 'Cash', bank_transfer: 'Bank transfer' }

export interface WalkInput {
  destination: WalkDestination
  /** The unit in another villa, when the guest stays with us. */
  unitId: string | null
  /** The outside property, when the guest leaves us. */
  property: string
  /** What the operator pays for the relocation, in whole rupiah; 0 when nothing. */
  cost: number
  method: WalkMethod
  /** What the guest gets for the trouble: a free transfer, dinner, a night back. */
  compensation: string
  reason: string
  receipts?: readonly Attachment[]
}

/** A guest the front desk walked, with what it cost. */
export interface Walk {
  id: string
  /** WLK-xxxx. */
  number: string
  bookingId: string
  bookingCode: string
  /** The room type that was overbooked. */
  groupId: string
  date: IsoDate
  destination: WalkDestination
  fromUnitId: string
  /** The unit the guest moved to inside the group, else null. */
  toUnitId: string | null
  property: string
  cost: number
  method: WalkMethod
  compensation: string
  reason: string
  /** The cash-out of the cost, when there is one. */
  transactionId: string | null
  by: string
  byId: string
}

export function validateWalk(input: WalkInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (input.destination === 'group_villa' && !input.unitId) errors.unitId = 'Pick the unit the guest moves to.'
  if (input.destination === 'outside' && input.property.trim().length < 3) errors.property = 'Name the property the guest goes to.'
  if (!Number.isInteger(input.cost) || input.cost < 0) errors.cost = 'Enter the cost in whole rupiah, or zero.'
  if (input.reason.trim().length < 3) errors.reason = 'Say why the guest is walked.'
  return errors
}
