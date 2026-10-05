import { addDays, daysBetween, maxIso, minIso, type IsoDate } from '@/lib/dates'
import type { Catalog, Unit } from './property'

export type BookingSource = 'direct' | 'airbnb'
export const SOURCE_LABEL: Record<BookingSource, string> = { direct: 'Direct', airbnb: 'Airbnb' }

export type BookingStatus = 'draft' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled'
export const BOOKING_STATUSES: readonly BookingStatus[] = ['draft', 'confirmed', 'checked_in', 'checked_out', 'cancelled']
export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
}

/** A unit change on a booking. The requested unit stays on the booking; the trail lives here. */
export interface UnitMovement {
  fromUnitId: string
  toUnitId: string
  on: IsoDate
  reason: string
}

/** What the front desk records when the guest arrives. */
export interface CheckInDetails {
  idVerified: boolean
  /** Rupiah held as security deposit; zero when none. */
  deposit: number
  keysHanded: boolean
  rulesExplained: boolean
  arrivalTime: string
  adults: number
  children: number
  notes: string
}

/** What the front desk records when the guest leaves. */
export interface CheckOutDetails {
  depositReturned: number
  /** Damage, minibar or late check-out charged on departure. */
  extraCharges: number
  roomInspected: boolean
  keysReturned: boolean
  notes: string
}

export function validateCheckIn(d: CheckInDetails): Partial<Record<keyof CheckInDetails, string>> {
  const errors: Partial<Record<keyof CheckInDetails, string>> = {}
  if (!d.idVerified) errors.idVerified = 'Match the ID against the booking before checking in.'
  if (!Number.isInteger(d.deposit) || d.deposit < 0) errors.deposit = 'Enter the deposit in whole rupiah, or zero.'
  if (!d.keysHanded) errors.keysHanded = 'Hand over the keys or access code.'
  if (!Number.isInteger(d.adults) || d.adults < 1) errors.adults = 'At least one adult.'
  if (!Number.isInteger(d.children) || d.children < 0) errors.children = 'Children cannot be negative.'
  return errors
}

export function validateCheckOut(d: CheckOutDetails, held: number): Partial<Record<keyof CheckOutDetails, string>> {
  const errors: Partial<Record<keyof CheckOutDetails, string>> = {}
  if (!Number.isInteger(d.depositReturned) || d.depositReturned < 0) errors.depositReturned = 'Enter the amount returned, or zero.'
  else if (d.depositReturned > held) errors.depositReturned = `Only ${held} is held as deposit.`
  if (!Number.isInteger(d.extraCharges) || d.extraCharges < 0) errors.extraCharges = 'Enter the charges in whole rupiah, or zero.'
  if (!d.roomInspected) errors.roomInspected = 'Inspect the room before closing the stay.'
  return errors
}

export interface Booking {
  id: string
  code: string
  guestId: string
  /** The unit the guest sleeps in. */
  unitId: string
  /** The unit the guest asked for; differs from `unitId` after a swap. */
  requestedUnitId: string
  source: BookingSource
  airbnbAccountId: string | null
  airbnbCode: string | null
  checkIn: IsoDate
  /** Exclusive: the guest leaves on this morning. */
  checkOut: IsoDate
  nightlyRate: number
  status: BookingStatus
  notes: string
  movements: readonly UnitMovement[]
  createdOn: IsoDate
  checkedInOn: IsoDate | null
  checkedOutOn: IsoDate | null
  arrival: CheckInDetails | null
  departure: CheckOutDetails | null
}

export type BlockReason = 'maintenance' | 'owner' | 'cleaning' | 'other'
export const BLOCK_REASONS: readonly BlockReason[] = ['maintenance', 'owner', 'cleaning', 'other']
export const BLOCK_REASON_LABEL: Record<BlockReason, string> = { maintenance: 'Maintenance', owner: 'Owner stay', cleaning: 'Deep clean', other: 'Other' }

/** Nights a unit cannot be sold. `to` is exclusive, like a check-out. */
export interface UnitBlock {
  id: string
  unitId: string
  from: IsoDate
  to: IsoDate
  reason: BlockReason
  note: string
}

export const nights = (b: Pick<Booking, 'checkIn' | 'checkOut'>) => daysBetween(b.checkIn, b.checkOut)
export const bookingTotal = (b: Pick<Booking, 'checkIn' | 'checkOut' | 'nightlyRate'>) => nights(b) * b.nightlyRate

/** Statuses that hold the unit. Drafts and cancellations never block availability. */
export const occupies = (b: Pick<Booking, 'status'>) => b.status === 'confirmed' || b.status === 'checked_in'
/** Statuses that earn revenue: everything a guest stays or stayed for. */
export const earns = (b: Pick<Booking, 'status'>) => b.status !== 'draft' && b.status !== 'cancelled'

/** Half-open ranges: a check-out morning and a check-in afternoon on the same day do not clash. */
export const overlaps = (aFrom: IsoDate, aTo: IsoDate, bFrom: IsoDate, bTo: IsoDate) => aFrom < bTo && bFrom < aTo

export const overlapNights = (aFrom: IsoDate, aTo: IsoDate, bFrom: IsoDate, bTo: IsoDate) =>
  Math.max(0, daysBetween(maxIso(aFrom, bFrom), minIso(aTo, bTo)))

export interface Conflict {
  kind: 'booking' | 'block'
  id: string
  from: IsoDate
  to: IsoDate
  label: string
}

/** Everything that already holds `unitId` during the stay. Empty means the nights are free. */
export function findConflicts(
  unitId: string,
  checkIn: IsoDate,
  checkOut: IsoDate,
  bookings: readonly Booking[],
  blocks: readonly UnitBlock[],
  excludeBookingId?: string,
): Conflict[] {
  const held: Conflict[] = bookings
    .filter((b) => b.unitId === unitId && b.id !== excludeBookingId && occupies(b) && overlaps(b.checkIn, b.checkOut, checkIn, checkOut))
    .map((b) => ({ kind: 'booking', id: b.id, from: b.checkIn, to: b.checkOut, label: b.code }))
  const blocked: Conflict[] = blocks
    .filter((k) => k.unitId === unitId && overlaps(k.from, k.to, checkIn, checkOut))
    .map((k) => ({ kind: 'block', id: k.id, from: k.from, to: k.to, label: BLOCK_REASON_LABEL[k.reason] }))
  return [...held, ...blocked].sort((a, b) => a.from.localeCompare(b.from))
}

export const MAX_NIGHTS = 90

/** Why a stay is impossible, or null. The backend repeats this check. */
export function validateStay(checkIn: string, checkOut: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) return 'Pick both dates.'
  const n = daysBetween(checkIn, checkOut)
  if (n < 1) return 'Check-out must be after check-in.'
  if (n > MAX_NIGHTS) return `A stay is at most ${MAX_NIGHTS} nights.`
  return null
}

export const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
}

export const canTransition = (b: Pick<Booking, 'status'>, to: BookingStatus) => TRANSITIONS[b.status].includes(to)

/** The one forward step: the accent action on the record page. */
export function nextStep(b: Pick<Booking, 'status'>): Exclude<BookingStatus, 'draft' | 'cancelled'> | null {
  return TRANSITIONS[b.status].find((s): s is Exclude<BookingStatus, 'draft' | 'cancelled'> => s !== 'cancelled') ?? null
}

export const ACTION_LABEL: Record<Exclude<BookingStatus, 'draft'>, string> = {
  confirmed: 'Confirm booking',
  checked_in: 'Check in',
  checked_out: 'Check out',
  cancelled: 'Cancel booking',
}

export interface LifecycleStep {
  id: string
  label: string
  hint?: string
  state: 'done' | 'current' | 'upcoming' | 'late'
}

const STEP_ORDER: readonly BookingStatus[] = ['draft', 'confirmed', 'checked_in', 'checked_out']
const STEP_LABEL: Record<BookingStatus, string> = { ...BOOKING_STATUS_LABEL, draft: 'Booked' }

/** Booked, Confirmed, Checked in, Checked out; a missed arrival or departure reads late. */
export function lifecycleSteps(b: Booking, today: IsoDate, fmt: (iso: IsoDate) => string): LifecycleStep[] {
  if (b.status === 'cancelled') {
    return [
      { id: 'draft', label: 'Booked', hint: fmt(b.createdOn), state: 'done' },
      { id: 'cancelled', label: 'Cancelled', state: 'current' },
    ]
  }
  const at = STEP_ORDER.indexOf(b.status)
  const hints: Record<BookingStatus, string | undefined> = {
    draft: fmt(b.createdOn),
    confirmed: b.status === 'draft' ? undefined : `Arrives ${fmt(b.checkIn)}`,
    checked_in: b.checkedInOn ? fmt(b.checkedInOn) : `Due ${fmt(b.checkIn)}`,
    checked_out: b.checkedOutOn ? fmt(b.checkedOutOn) : `Due ${fmt(b.checkOut)}`,
    cancelled: undefined,
  }
  const late = (b.status === 'confirmed' && b.checkIn < today) || (b.status === 'checked_in' && b.checkOut < today)
  return STEP_ORDER.map((s, i) => ({
    id: s,
    label: STEP_LABEL[s],
    hint: hints[s],
    state: i < at ? 'done' : i === at ? (late ? 'late' : 'current') : 'upcoming',
  }))
}

/** Interchangeable units that are free for these nights. */
export function interchangeableFree(
  catalog: Catalog,
  unitId: string,
  checkIn: IsoDate,
  checkOut: IsoDate,
  bookings: readonly Booking[],
  blocks: readonly UnitBlock[],
  excludeBookingId?: string,
): Unit[] {
  return interchangeableUnits(catalog, unitId).filter((u) => findConflicts(u.id, checkIn, checkOut, bookings, blocks, excludeBookingId).length === 0)
}

/** Interchangeable units that are free for this booking's nights. */
export const swapTargets = (b: Booking, catalog: Catalog, bookings: readonly Booking[], blocks: readonly UnitBlock[]) =>
  interchangeableFree(catalog, b.unitId, b.checkIn, b.checkOut, bookings, blocks, b.id)

function interchangeableUnits(catalog: Catalog, unitId: string): Unit[] {
  const { unit, group } = catalog.place(unitId)
  if (!group?.interchangeable) return []
  return catalog.units.filter((u) => u.groupId === group.id && u.id !== unit.id && u.status === 'active')
}

export type NightState = 'free' | 'occupied' | 'blocked' | 'closed'

/** What a unit is doing on one night. Inactive units read closed. */
export function nightState(unit: Unit, date: IsoDate, bookings: readonly Booking[], blocks: readonly UnitBlock[]): NightState {
  if (unit.status === 'inactive') return 'closed'
  if (blocks.some((k) => k.unitId === unit.id && k.from <= date && date < k.to)) return 'blocked'
  if (bookings.some((b) => b.unitId === unit.id && occupies(b) && b.checkIn <= date && date < b.checkOut)) return 'occupied'
  return 'free'
}

export interface Occupancy {
  unitNights: number
  blockedNights: number
  occupiedNights: number
  /** Occupied over sellable nights, 0 when nothing was sellable. */
  rate: number
}

/** Nights sold over nights sellable in [from, to), for the given units. */
export function occupancy(units: readonly Unit[], bookings: readonly Booking[], blocks: readonly UnitBlock[], from: IsoDate, to: IsoDate): Occupancy {
  const ids = new Set(units.filter((u) => u.status !== 'inactive').map((u) => u.id))
  const span = Math.max(0, daysBetween(from, to))
  const unitNights = ids.size * span
  const blockedNights = blocks.filter((k) => ids.has(k.unitId)).reduce((s, k) => s + overlapNights(k.from, k.to, from, to), 0)
  const occupiedNights = bookings
    .filter((b) => ids.has(b.unitId) && earns(b))
    .reduce((s, b) => s + overlapNights(b.checkIn, b.checkOut, from, to), 0)
  const sellable = unitNights - blockedNights
  return { unitNights, blockedNights, occupiedNights, rate: sellable > 0 ? occupiedNights / sellable : 0 }
}

/** Room revenue earned night by night inside [from, to). */
export function revenueBetween(bookings: readonly Booking[], from: IsoDate, to: IsoDate): number {
  return bookings.filter(earns).reduce((s, b) => s + overlapNights(b.checkIn, b.checkOut, from, to) * b.nightlyRate, 0)
}

export function nightsBetween(bookings: readonly Booking[], from: IsoDate, to: IsoDate): number {
  return bookings.filter(earns).reduce((s, b) => s + overlapNights(b.checkIn, b.checkOut, from, to), 0)
}

export const arrivalsOn = <T extends Booking>(bookings: readonly T[], date: IsoDate) => bookings.filter((b) => b.status === 'confirmed' && b.checkIn === date)
export const departuresOn = <T extends Booking>(bookings: readonly T[], date: IsoDate) => bookings.filter((b) => b.status === 'checked_in' && b.checkOut === date)
export const inHouse = <T extends Booking>(bookings: readonly T[]) => bookings.filter((b) => b.status === 'checked_in')

export interface BookingFilter {
  status?: BookingStatus | 'all'
  source?: string
  query?: string
  guestId?: string
  unitId?: string
  /** Keep stays that touch any night between these dates (inclusive). */
  from?: string
  to?: string
}

/** `source` is "direct" or an Airbnb account id; `query` matches code, guest and unit text. */
export function filterBookings<T extends Booking & { guestName: string; unitCode: string }>(list: readonly T[], f: BookingFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((b) => {
    if (f.status && f.status !== 'all' && b.status !== f.status) return false
    if (f.source === 'direct' && b.source !== 'direct') return false
    if (f.source && f.source !== 'direct' && b.airbnbAccountId !== f.source) return false
    if (f.guestId && b.guestId !== f.guestId) return false
    if (f.unitId && b.unitId !== f.unitId) return false
    if (f.from && b.checkOut <= f.from) return false
    if (f.to && b.checkIn > f.to) return false
    if (q && ![b.code, b.guestName, b.unitCode, b.airbnbCode ?? ''].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

/** Sort key for lists: live stays first, then by arrival. */
export function sortBookings<T extends Booking>(list: readonly T[], today: IsoDate): T[] {
  const rank = (b: Booking) => (b.status === 'checked_in' ? 0 : b.status === 'confirmed' && b.checkIn >= today ? 1 : b.status === 'draft' ? 2 : 3)
  return [...list].sort((a, b) => rank(a) - rank(b) || (rank(a) < 3 ? a.checkIn.localeCompare(b.checkIn) : b.checkIn.localeCompare(a.checkIn)))
}

/** The 14 nights a unit strip shows, starting today. */
export const stripDays = (today: IsoDate, days = 14) => Array.from({ length: days }, (_, i) => addDays(today, i))
