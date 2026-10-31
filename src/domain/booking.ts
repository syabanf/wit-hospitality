import { addDays, daysBetween, maxIso, minIso, type IsoDate } from '@/lib/dates'
import { nightCharges, stayPrice, type DiscountInput, type PriceStamp } from './pricing'
import type { Catalog, Unit, UnitGroup } from './property'

export type BookingSource = 'direct' | 'airbnb'
export const SOURCE_LABEL: Record<BookingSource, string> = { direct: 'Direct', airbnb: 'Airbnb' }
/** Channel bookings keep the price the channel sold; only direct stays are repriced or discounted here. */
export const isChannel = (b: Pick<Booking, 'source'>) => b.source !== 'direct'

export type BookingStatus = 'draft' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled' | 'no_show'
export const BOOKING_STATUSES: readonly BookingStatus[] = ['draft', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show']
export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  checked_out: 'Checked out',
  cancelled: 'Cancelled',
  no_show: 'No show',
}

export type PaymentStatus = 'unpaid' | 'partial' | 'paid'
export const PAYMENT_STATUSES: readonly PaymentStatus[] = ['unpaid', 'partial', 'paid']
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = { unpaid: 'Unpaid', partial: 'Partly paid', paid: 'Paid' }

/** What the booking earns after the channel takes its cut: Airbnb fee, payout, what the guest has paid. */
export interface PaymentInput {
  paymentStatus: PaymentStatus
  paidAmount: number
  /** Host service fee Airbnb keeps; zero for direct bookings. */
  airbnbFee: number
}

export function validatePayment(p: PaymentInput, total: number, source: BookingSource): Partial<Record<keyof PaymentInput, string>> {
  const errors: Partial<Record<keyof PaymentInput, string>> = {}
  if (!PAYMENT_STATUSES.includes(p.paymentStatus)) errors.paymentStatus = 'Pick the payment status.'
  if (!Number.isInteger(p.paidAmount) || p.paidAmount < 0) errors.paidAmount = 'Enter the amount paid in whole rupiah, or zero.'
  else if (p.paidAmount > total) errors.paidAmount = 'More than the booking total.'
  if (!Number.isInteger(p.airbnbFee) || p.airbnbFee < 0) errors.airbnbFee = 'Enter the Airbnb fee in whole rupiah, or zero.'
  else if (p.airbnbFee > total) errors.airbnbFee = 'The fee cannot exceed the booking total.'
  else if (source === 'direct' && p.airbnbFee > 0) errors.airbnbFee = 'A direct booking has no Airbnb fee.'
  return errors
}

/** A unit change on a booking. The requested unit stays on the booking; the trail lives here. */
export interface UnitMovement {
  fromUnitId: string
  toUnitId: string
  on: IsoDate
  reason: string
  /** Who moved the guest. */
  by: string
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
  /**
   * The unit the guest sleeps in. While `unitAssigned` is false the guest booked the room type and
   * this is a placeholder in that type, so the villa and location still resolve.
   */
  unitId: string
  /** False until the operator picks the room, in villas whose room type is sold instead of the unit. */
  unitAssigned: boolean
  /** The unit the guest asked for; differs from `unitId` after a swap. */
  requestedUnitId: string
  source: BookingSource
  airbnbAccountId: string | null
  airbnbCode: string | null
  checkIn: IsoDate
  /** Exclusive: the guest leaves on this morning. */
  checkOut: IsoDate
  /** List price of each night: the listing for a direct stay, the channel price for Airbnb. */
  listRates: readonly number[]
  /** A staff rate replacing the list on every night, direct stays only. */
  rateOverride: number | null
  discount: DiscountInput | null
  /** Set when staff priced the stay away from the list. */
  priceSetBy: PriceStamp | null
  status: BookingStatus
  notes: string
  paymentStatus: PaymentStatus
  paidAmount: number
  airbnbFee: number
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

type Priced = Pick<Booking, 'listRates' | 'rateOverride' | 'discount'>

export const nights = (b: Pick<Booking, 'checkIn' | 'checkOut'>) => daysBetween(b.checkIn, b.checkOut)
export const bookingTotal = (b: Priced) => stayPrice(b).total
/** What reaches the company: the total less the channel fee. */
export const bookingPayout = (b: Priced & Pick<Booking, 'airbnbFee'>) => bookingTotal(b) - b.airbnbFee
/** The average a night costs, for lists and invoices. */
export const averageRate = (b: Priced) => (b.listRates.length ? Math.round(bookingTotal(b) / b.listRates.length) : 0)

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
    .filter((b) => b.unitId === unitId && b.unitAssigned && b.id !== excludeBookingId && occupies(b) && overlaps(b.checkIn, b.checkOut, checkIn, checkOut))
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
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
  no_show: [],
}

export const canTransition = (b: Pick<Booking, 'status'>, to: BookingStatus) => TRANSITIONS[b.status].includes(to)

/** The one forward step: the accent action on the record page. */
export function nextStep(b: Pick<Booking, 'status'>): Exclude<BookingStatus, 'draft' | 'cancelled' | 'no_show'> | null {
  return TRANSITIONS[b.status].find((s): s is Exclude<BookingStatus, 'draft' | 'cancelled' | 'no_show'> => s !== 'cancelled' && s !== 'no_show') ?? null
}

export const ACTION_LABEL: Record<Exclude<BookingStatus, 'draft'>, string> = {
  confirmed: 'Confirm booking',
  checked_in: 'Check in',
  checked_out: 'Check out',
  cancelled: 'Cancel booking',
  no_show: 'Mark no-show',
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
  if (b.status === 'cancelled' || b.status === 'no_show') {
    return [
      { id: 'draft', label: 'Booked', hint: fmt(b.createdOn), state: 'done' },
      { id: 'confirmed', label: 'Confirmed', hint: `Arrival ${fmt(b.checkIn)}`, state: 'done' },
      { id: b.status, label: BOOKING_STATUS_LABEL[b.status], state: b.status === 'no_show' ? 'late' : 'current' },
    ]
  }
  const at = STEP_ORDER.indexOf(b.status)
  const hints: Record<BookingStatus, string | undefined> = {
    draft: fmt(b.createdOn),
    confirmed: b.status === 'draft' ? undefined : `Arrives ${fmt(b.checkIn)}`,
    checked_in: b.checkedInOn ? fmt(b.checkedInOn) : `Due ${fmt(b.checkIn)}`,
    checked_out: b.checkedOutOn ? fmt(b.checkedOutOn) : `Due ${fmt(b.checkOut)}`,
    cancelled: undefined,
    no_show: undefined,
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
  if (bookings.some((b) => b.unitId === unit.id && b.unitAssigned && occupies(b) && b.checkIn <= date && date < b.checkOut)) return 'occupied'
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
  return bookings.filter(earns).reduce((s, b) => s + chargedBetween(b, from, to), 0)
}

/** What one stay charges for its nights inside [from, to). */
export function chargedBetween(b: Pick<Booking, 'checkIn'> & Priced, from: IsoDate, to: IsoDate): number {
  return nightCharges(b).reduce((s, charge, i) => {
    const date = addDays(b.checkIn, i)
    return date >= from && date < to ? s + charge : s
  }, 0)
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

/** Whether guests book this room type and the operator picks the room. */
export const sellsRoomType = (group: Pick<UnitGroup, 'operatorAssigns'> | null | undefined) => Boolean(group?.operatorAssigns)

export interface TypeAvailability {
  /** Rooms of the type still free on the tightest night of the stay. */
  free: number
  /** Rooms free on every night, the ones an operator can assign. */
  units: Unit[]
}

/**
 * Room-type capacity for a stay: per night, the type's open rooms less blocks, assigned stays and
 * stays still waiting for a room. A booking against the type needs `free` above zero.
 */
export function typeAvailability(
  catalog: Catalog,
  groupId: string,
  checkIn: IsoDate,
  checkOut: IsoDate,
  bookings: readonly Booking[],
  blocks: readonly UnitBlock[],
  excludeBookingId?: string,
): TypeAvailability {
  const rooms = catalog.units.filter((u) => u.groupId === groupId && u.status !== 'inactive')
  const ids = new Set(rooms.map((u) => u.id))
  const live = bookings.filter((b) => b.id !== excludeBookingId && occupies(b) && ids.has(b.unitId) && overlaps(b.checkIn, b.checkOut, checkIn, checkOut))
  const span = Math.max(0, daysBetween(checkIn, checkOut))
  let free = rooms.length
  for (let i = 0; i < span; i++) {
    const date = addDays(checkIn, i)
    const taken = new Set([
      ...blocks.filter((k) => ids.has(k.unitId) && k.from <= date && date < k.to).map((k) => k.unitId),
      ...live.filter((b) => b.unitAssigned && b.checkIn <= date && date < b.checkOut).map((b) => b.unitId),
    ])
    const waiting = live.filter((b) => !b.unitAssigned && b.checkIn <= date && date < b.checkOut).length
    free = Math.min(free, rooms.length - taken.size - waiting)
  }
  return { free: Math.max(0, free), units: rooms.filter((u) => findConflicts(u.id, checkIn, checkOut, bookings, blocks, excludeBookingId).length === 0) }
}

/** Confirmed stays still waiting for a room, soonest arrival first. */
export const unassigned = <T extends Booking>(bookings: readonly T[]) => bookings.filter((b) => !b.unitAssigned && (b.status === 'confirmed' || b.status === 'draft')).sort((a, b) => a.checkIn.localeCompare(b.checkIn))
