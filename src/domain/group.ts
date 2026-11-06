import type { IsoDate } from '@/lib/dates'
import { findConflicts, sellsRoomType, typeAvailability, validateStay, type Booking, type Holding, type UnitBlock } from './booking'
import { byPosting, folioOnMaster, runningBalance, type FolioLine, type GuestFolio } from './folio'
import type { Payment } from './payment'
import type { PriceChange } from './pricing'
import type { Catalog } from './property'
import type { CityLedgerBilling } from './cityLedger'

/**
 * A group reservation: several units booked together for one party (a wedding, a retreat, a family,
 * a company). Every stay stays a normal booking that points at the group; the group adds one lead
 * guest, one deposit and, when billed to a master folio, one bill for every room night.
 */

export type GroupSource = 'direct' | 'corporate'
export const GROUP_SOURCES: readonly GroupSource[] = ['direct', 'corporate']
export const GROUP_SOURCE_LABEL: Record<GroupSource, string> = { direct: 'Direct', corporate: 'Corporate' }

/** `master`: the group pays every room night on one folio, each stay its own extras. `per_stay`: each stay pays its own folio. */
export type GroupBilling = 'master' | 'per_stay'
export const GROUP_BILLINGS: readonly GroupBilling[] = ['master', 'per_stay']
export const GROUP_BILLING_LABEL: Record<GroupBilling, string> = { master: 'Master folio', per_stay: 'Each stay pays' }

/** Percent off every stay of the group that carries no discount of its own. */
export interface GroupDiscount {
  pct: number
  reason: string
}

export interface BookingGroup {
  id: string
  /** GRP-xxxx. */
  code: string
  name: string
  leadGuestId: string
  /** The villas its stays sit in, in the order they were booked. */
  villaIds: readonly string[]
  source: GroupSource
  billing: GroupBilling
  discount: GroupDiscount | null
  note: string
  createdBy: string
  /** ISO date-time. */
  createdAt: string
  /** The company or travel agent the group's bill goes to after the stay. */
  cityLedger?: CityLedgerBilling
}

/** One stay asked for in a group: a unit, or a room type the operator assigns later. */
export interface GroupStayInput {
  unitId: string | null
  roomTypeId: string | null
  checkIn: IsoDate
  checkOut: IsoDate
  adults: number
  children: number
  /** A staff rate or discount on this stay alone. */
  price: PriceChange | null
}

export interface GroupInput {
  name: string
  hasGuest: boolean
  stays: readonly GroupStayInput[]
  discount: GroupDiscount | null
}

export const MAX_GROUP_STAYS = 30

export function validateGroupStay(s: GroupStayInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!s.unitId && !s.roomTypeId) errors.unitId = 'Pick a unit or a room type.'
  const stay = validateStay(s.checkIn, s.checkOut)
  if (stay) errors.checkOut = stay
  if (!Number.isInteger(s.adults) || s.adults < 1) errors.adults = 'At least one adult.'
  if (!Number.isInteger(s.children) || s.children < 0) errors.children = 'Children cannot be negative.'
  return errors
}

/** Field errors keyed the way the form names them: `stays.2.checkOut`, `discount.pct`. */
export function validateGroup(input: GroupInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (input.name.trim().length < 3) errors.name = 'Name the group, for example the couple or the company.'
  if (!input.hasGuest) errors.guestId = 'Pick the lead guest or add a new one.'
  if (input.stays.length < 2) errors.stays = 'A group books at least two stays.'
  if (input.stays.length > MAX_GROUP_STAYS) errors.stays = `A group books at most ${MAX_GROUP_STAYS} stays.`
  input.stays.forEach((s, i) => {
    for (const [k, v] of Object.entries(validateGroupStay(s))) errors[`stays.${i}.${k}`] = v
  })
  if (input.discount) {
    if (!(input.discount.pct > 0 && input.discount.pct <= 100)) errors['discount.pct'] = 'A percentage above 0, up to 100.'
    if (input.discount.reason.trim().length < 3) errors['discount.reason'] = 'Say why the group gets the discount.'
  }
  return errors
}

/** The stay's own price, or the group discount when the stay has no discount of its own. */
export function stayPriceChange(own: PriceChange | null, discount: GroupDiscount | null): PriceChange | null {
  if (!discount || own?.discount) return own
  return { rateOverride: own?.rateOverride ?? null, discount: { kind: 'percent', value: discount.pct, per: 'stay', reason: `Group discount: ${discount.reason.trim()}` }, reason: own?.reason ?? '' }
}

export interface GroupClash {
  index: number
  /** The unit code, or the room type name. */
  label: string
  detail: string
}

/**
 * Every stay of a group that cannot be booked, tested against the stays already held and the
 * earlier stays of the same group, so two stays never claim one room. Empty means all are free.
 */
export function groupClashes(catalog: Catalog, stays: readonly GroupStayInput[], bookings: readonly Holding[], blocks: readonly UnitBlock[], overbookOf: (groupId: string) => number = () => 0): GroupClash[] {
  const held: Holding[] = [...bookings]
  const clashes: GroupClash[] = []
  stays.forEach((s, index) => {
    if (validateStay(s.checkIn, s.checkOut)) return
    const unit = s.unitId ? catalog.unit(s.unitId) : catalog.units.find((u) => u.groupId === s.roomTypeId && u.status !== 'inactive')
    if (!unit) {
      clashes.push({ index, label: 'Room type', detail: 'has no open room.' })
      return
    }
    const group = unit.groupId ? catalog.group(unit.groupId) : null
    const label = s.unitId ? unit.code : (group?.name ?? unit.code)
    const first = s.unitId ? findConflicts(unit.id, s.checkIn, s.checkOut, held, blocks)[0] : undefined
    const typeFull = sellsRoomType(group) && typeAvailability(catalog, group?.id ?? '', s.checkIn, s.checkOut, held, blocks, undefined, overbookOf(group?.id ?? '')).sellable < 1
    if (s.unitId && unit.status === 'inactive') clashes.push({ index, label, detail: 'is inactive.' })
    else if (first) clashes.push({ index, label, detail: `is held by ${first.label} from ${first.from} to ${first.to}.` })
    else if (typeFull) clashes.push({ index, label, detail: 'has every room taken on at least one of those nights.' })
    else held.push({ id: `group-stay-${index}`, code: `stay ${index + 1} of this group`, unitId: unit.id, unitAssigned: Boolean(s.unitId), status: 'confirmed', checkIn: s.checkIn, checkOut: s.checkOut })
  })
  return clashes
}

export const clashMessage = (clashes: readonly GroupClash[]) => `The group cannot be booked: ${clashes.map((c) => `${c.label} ${c.detail.replace(/\.$/, '')}`).join('; ')}.`

export type GroupStatus = 'draft' | 'confirmed' | 'in_house' | 'checked_out' | 'cancelled'
export const GROUP_STATUSES: readonly GroupStatus[] = ['draft', 'confirmed', 'in_house', 'checked_out', 'cancelled']
export const GROUP_STATUS_LABEL: Record<GroupStatus, string> = { draft: 'Draft', confirmed: 'Confirmed', in_house: 'In house', checked_out: 'Checked out', cancelled: 'Cancelled' }

/** Stays still to arrive, in house, or waiting to be confirmed. */
export const liveStay = (b: Pick<Booking, 'status'>) => b.status === 'draft' || b.status === 'confirmed' || b.status === 'checked_in'

/** The group reads from its stays: in house while anyone is, out once every stay that came has left. */
export function groupStatus(stays: readonly Pick<Booking, 'status'>[]): GroupStatus {
  const came = stays.filter((b) => b.status !== 'cancelled' && b.status !== 'no_show')
  if (came.length === 0) return 'cancelled'
  if (came.some((b) => b.status === 'checked_in')) return 'in_house'
  if (came.every((b) => b.status === 'checked_out')) return 'checked_out'
  return came.some((b) => b.status === 'confirmed') ? 'confirmed' : 'draft'
}

/** Whether `bookingId` is the last stay of the group still to leave, the one whose check-out closes the master folio. */
export const closesGroup = (stays: readonly Pick<Booking, 'id' | 'status'>[], bookingId: string) => stays.every((b) => b.id === bookingId || !liveStay(b))

/** Stays the desk checks in together: confirmed and due today or earlier. */
export const arrivingStays = <T extends Pick<Booking, 'status' | 'checkIn'>>(stays: readonly T[], today: IsoDate) => stays.filter((b) => b.status === 'confirmed' && b.checkIn <= today)

/** Stays in the order money and lists take them: by arrival, then by code. */
export const stayOrder = <T extends Pick<Booking, 'checkIn' | 'code'>>(stays: readonly T[]) => [...stays].sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.code.localeCompare(b.code))

/** Splits one group payment over the stays in order, each up to what it still owes. */
export function allocate(amount: number, dues: readonly { bookingId: string; due: number }[]): Array<{ bookingId: string; amount: number }> {
  let left = amount
  const shares: Array<{ bookingId: string; amount: number }> = []
  for (const d of dues) {
    const share = Math.min(left, Math.max(0, d.due))
    if (share > 0) shares.push({ bookingId: d.bookingId, amount: share })
    left -= share
  }
  return shares
}

export interface MasterLine extends FolioLine {
  balance: number
  /** The stays the line belongs to, by code. */
  stays: readonly string[]
}

export interface MasterFolio {
  lines: MasterLine[]
  debits: number
  credits: number
  balance: number
  /** Room nights the audit has not posted yet. */
  forecast: number
  /** What the group still owes on its room nights, the forecast ones included. */
  due: number
}

/**
 * The group's master folio: the room lines of every stay, read off each stay's full folio. The
 * shares of one group payment show as the one payment the group made.
 */
export function masterFolio(stays: ReadonlyArray<{ booking: Pick<Booking, 'code'>; folio: Pick<GuestFolio, 'lines'> }>, payments: readonly Pick<Payment, 'id' | 'batch'>[]): MasterFolio {
  const merged = new Map<string, Omit<MasterLine, 'balance'>>()
  for (const { booking, folio } of stays) {
    for (const { balance: _balance, ...line } of folio.lines.filter(folioOnMaster)) {
      const batch = line.ref.type === 'payment' ? payments.find((p) => p.id === line.ref.id)?.batch : undefined
      const key = batch ? `${batch}|${line.kind}` : `${booking.code}|${line.id}`
      const known = merged.get(key)
      const codes = [...(known?.stays ?? []), booking.code]
      const description = batch ? `Group payment ${batch} over ${codes.join(', ')}` : `${booking.code} · ${line.description}`
      merged.set(key, known ? { ...known, debit: known.debit + line.debit, credit: known.credit + line.credit, stays: codes, description } : { ...line, id: key, description, stays: codes, ...(batch ? { ref: { ...line.ref, label: batch } } : {}) })
    }
  }
  const { lines, debits, credits, forecast } = runningBalance([...merged.values()].sort(byPosting))
  return { lines, debits, credits, balance: debits - credits, forecast, due: Math.max(0, debits - credits + forecast) }
}

export interface GroupFilter {
  query?: string
  status?: GroupStatus | 'all'
}

export function filterGroups<T extends { group: Pick<BookingGroup, 'code' | 'name'>; leadName: string; status: GroupStatus }>(rows: readonly T[], f: GroupFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return rows.filter((r) => (!f.status || f.status === 'all' || r.status === f.status) && (!q || [r.group.code, r.group.name, r.leadName].some((v) => v.toLowerCase().includes(q))))
}
