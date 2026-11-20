import type { IsoDate } from '@/lib/dates'
import type { Booking } from './booking'
import { RuleError } from './errors'

/**
 * Housekeeping records what it finds in each room on its round; the check keeps the front office
 * side as it stood then, and any disagreement is a discrepancy the desk resolves. Contract:
 * api/docs/contracts/front-office-controls-contract.md section 1.
 */

export type FoundStatus = 'occupied' | 'vacant' | 'out_of_order'
export const FOUND_STATUSES: readonly FoundStatus[] = ['occupied', 'vacant', 'out_of_order']
export const FOUND_LABEL: Record<FoundStatus, string> = { occupied: 'Occupied', vacant: 'Vacant', out_of_order: 'Out of order' }

export type DiscrepancyKind = 'sleep' | 'skip' | 'persons'
export const DISCREPANCY_LABEL: Record<DiscrepancyKind, string> = { sleep: 'Sleep', skip: 'Skip', persons: 'Person count' }
export const DISCREPANCY_HINT: Record<DiscrepancyKind, string> = {
  sleep: 'The front office has a guest in house; housekeeping found the room empty. The guest may have left without checking out.',
  skip: 'The front office has the room vacant; housekeeping found it occupied. Someone may be staying without a check-in.',
  persons: 'Housekeeping counted a different number of guests than the stay registered.',
}

export type DiscrepancyAction = 'checked_out' | 'checked_in' | 'housekeeping_error' | 'guest_out'
export const DISCREPANCY_ACTION_LABEL: Record<DiscrepancyAction, string> = {
  checked_out: 'Checked out the guest',
  checked_in: 'Checked in the walk-in',
  housekeeping_error: 'Housekeeping error',
  guest_out: 'Guest out for the night',
}
/** The actions that settle each kind of discrepancy. */
export const RESOLVE_ACTIONS: Record<DiscrepancyKind, readonly DiscrepancyAction[]> = {
  sleep: ['checked_out', 'guest_out', 'housekeeping_error'],
  skip: ['checked_in', 'housekeeping_error'],
  persons: ['guest_out', 'housekeeping_error'],
}

export interface Resolution {
  action: DiscrepancyAction
  note: string
  by: string
  at: string
}

export interface RoomCheck {
  /** `rc-<date>-<unitId>`: one check per room per day. */
  id: string
  unitId: string
  villaId: string
  date: IsoDate
  found: FoundStatus
  /** Guests housekeeping saw; occupied only, null when not counted. */
  persons: number | null
  note: string
  checkedBy: string
  checkedAt: string
  frontOffice: 'occupied' | 'vacant'
  bookingId: string | null
  bookingCode: string | null
  frontPersons: number | null
  discrepancy: DiscrepancyKind | null
  resolution: Resolution | null
}

export interface RoomCheckInput {
  unitId: string
  date: IsoDate
  found: FoundStatus
  persons: number | null
  note: string
}

export interface ResolveInput {
  action: DiscrepancyAction
  note: string
}

export const roomCheckId = (date: IsoDate, unitId: string) => `rc-${date}-${unitId}`
export const isOpenDiscrepancy = (c: Pick<RoomCheck, 'discrepancy' | 'resolution'>) => c.discrepancy !== null && c.resolution === null

const MAX_NOTE = 300
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const length = (s: string) => [...s.trim()].length

export function validateRoomCheck(input: RoomCheckInput, today: IsoDate): Partial<Record<keyof RoomCheckInput, string>> {
  const errors: Partial<Record<keyof RoomCheckInput, string>> = {}
  if (!ISO_DAY.test(input.date)) errors.date = 'Pick the day.'
  else if (input.date > today) errors.date = `${input.date} has not come yet.`
  if (!FOUND_STATUSES.includes(input.found)) errors.found = 'Pick what housekeeping found.'
  if (input.found === 'occupied' && input.persons !== null && (!Number.isInteger(input.persons) || input.persons < 1 || input.persons > 20)) errors.persons = 'Enter the guests seen as a whole number from 1, or leave it empty.'
  if (length(input.note) > MAX_NOTE) errors.note = 'Keep the note under 300 characters.'
  return errors
}

/** The stay that makes the unit occupied on the date: assigned to it, checked in, arrived on or before the date. */
export const frontOfficeStay = <B extends Pick<Booking, 'unitId' | 'unitAssigned' | 'status' | 'checkIn'>>(bookings: readonly B[], unitId: string, date: IsoDate) =>
  bookings.find((b) => b.unitAssigned && b.unitId === unitId && b.status === 'checked_in' && b.checkIn <= date) ?? null

/** Who the front office has in the room: the check-in record, else the booked party, else unknown. */
export function stayPersons(b: Pick<Booking, 'arrival' | 'partySize'>): number | null {
  if (b.arrival) return b.arrival.adults + b.arrival.children
  if (b.partySize) return b.partySize.adults + b.partySize.children
  return null
}

/** What the check and the front office disagree on, or null. */
export function discrepancyOf(found: FoundStatus, persons: number | null, frontOccupied: boolean, frontPersons: number | null): DiscrepancyKind | null {
  if (frontOccupied && (found === 'vacant' || found === 'out_of_order')) return 'sleep'
  if (!frontOccupied && found === 'occupied') return 'skip'
  if (frontOccupied && found === 'occupied' && persons !== null && frontPersons !== null && persons !== frontPersons) return 'persons'
  return null
}

/** Throws DISCREPANCY_NONE or DISCREPANCY_RESOLVED, else returns the field errors. */
export function validateResolve(check: RoomCheck, unitCode: string, input: ResolveInput): Partial<Record<keyof ResolveInput, string>> {
  if (!check.discrepancy) throw new RuleError('DISCREPANCY_NONE', `${unitCode} on ${check.date} matches the front office; nothing to resolve.`)
  if (check.resolution) throw new RuleError('DISCREPANCY_RESOLVED', `${unitCode} on ${check.date} was resolved by ${check.resolution.by}.`)
  const errors: Partial<Record<keyof ResolveInput, string>> = {}
  if (!(input.action in DISCREPANCY_ACTION_LABEL)) errors.action = 'Pick how the desk settled it.'
  else if (!RESOLVE_ACTIONS[check.discrepancy].includes(input.action)) errors.action = `${DISCREPANCY_ACTION_LABEL[input.action]} does not settle a ${DISCREPANCY_LABEL[check.discrepancy].toLowerCase()} discrepancy.`
  if (length(input.note) < 3) errors.note = 'Say what the desk found.'
  else if (length(input.note) > MAX_NOTE) errors.note = 'Keep the note under 300 characters.'
  return errors
}

/** The audit line of a recorded check. */
export function checkSummary(c: Pick<RoomCheck, 'date' | 'found' | 'persons' | 'discrepancy'>, unitCode: string): string {
  const guests = c.persons === null ? '' : `, ${c.persons} ${c.persons === 1 ? 'guest' : 'guests'}`
  return `Recorded ${unitCode} on ${c.date}: ${FOUND_LABEL[c.found]}${guests}${c.discrepancy ? `, ${DISCREPANCY_LABEL[c.discrepancy]} discrepancy` : ''}`
}

/**
 * The night audit's rule: with open discrepancies the day closes only with a reason from someone
 * who may override. Returns the override the audit keeps, null when nothing is open.
 */
export function discrepancyBlock(open: number, override: { reason: string } | null | undefined, mayOverride: boolean, by: string): { by: string; reason: string } | null {
  if (open === 0) return null
  if (!override) throw new RuleError('AUDIT_DISCREPANCIES', open === 1 ? '1 room discrepancy is still open; resolve it before closing the day.' : `${open} room discrepancies are still open; resolve them before closing the day.`)
  const reason = override.reason.trim()
  if ([...reason].length < 3) throw new RuleError('AUDIT_DISCREPANCIES', 'Give the reason to close the day over open discrepancies.')
  if (!mayOverride) throw new RuleError('AUDIT_DISCREPANCIES', 'Only a villa manager or someone who approves bookings may close the day over open discrepancies.')
  return { by, reason }
}
