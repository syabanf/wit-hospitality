import type { Profile } from '@/domain/account'
import type { AirbnbAccount, Listing } from '@/domain/airbnb'
import type { Booking, BookingStatus, UnitBlock } from '@/domain/booking'
import type { CashAccount, Category, Transaction } from '@/domain/finance'
import type { Guest } from '@/domain/guest'
import type { ServiceRequest } from '@/domain/roomService'
import { buildCatalog, type Catalog, type Location, type Unit, type UnitGroup, type Villa } from '@/domain/property'
import { addDays, type IsoDate } from '@/lib/dates'
import { PROFILE } from './data/account'
import { ACCOUNTS as AIRBNB_ACCOUNTS, LISTINGS } from './data/airbnb'
import { BLOCKS, EXTRA_BOOKINGS, expandPlans, UNIT_PLANS, type PlannedStay } from './data/bookings'
import { ACCOUNTS as CASH_ACCOUNTS, CATEGORIES, TRANSACTIONS } from './data/finance'
import { GUESTS } from './data/guests'
import { GROUPS, LOCATIONS, UNITS, VILLAS } from './data/property'
import { SERVICE_REQUESTS } from './data/services'
import { round } from './helpers'

/** Every table the mock API serves, built once from the seed files for one `today`. */
export interface MockState {
  today: IsoDate
  locations: Location[]
  villas: Villa[]
  units: Unit[]
  groups: UnitGroup[]
  /** Rebuilt from the four tables above, so edits show up in every lookup. */
  catalog(): Catalog
  accounts: AirbnbAccount[]
  listings: Listing[]
  guests: Guest[]
  bookings: Booking[]
  blocks: UnitBlock[]
  cashAccounts: CashAccount[]
  categories: Category[]
  transactions: Transaction[]
  requests: ServiceRequest[]
  profile: Profile
  nextBooking: number
  nextGuest: number
  nextTransaction: number
  nextBlock: number
  nextCategory: number
  nextEntity: number
  nextRequest: number
}

/** Deterministic Airbnb confirmation code from a sequence number. */
export const airbnbCode = (seq: number) => `HM${((seq * 2654435761) % 2176782336).toString(36).toUpperCase().padStart(6, '0').slice(-6)}`

function statusFor(checkIn: IsoDate, checkOut: IsoDate, today: IsoDate): BookingStatus {
  if (checkOut < today) return 'checked_out'
  if (checkIn < today) return 'checked_in'
  return 'confirmed'
}

/** The tables worth keeping between reloads; the catalog is rebuilt from them. */
export type Snapshot = Omit<MockState, 'catalog'>

export function snapshot(s: MockState): Snapshot {
  const { catalog: _catalog, ...tables } = s
  return tables
}

export function restore(s: MockState, saved: Snapshot): void {
  Object.assign(s, saved)
}

export function buildState(today: IsoDate): MockState {
  const catalog = buildCatalog(LOCATIONS, VILLAS, UNITS, GROUPS)
  const listingOf = (unitId: string) => LISTINGS.find((l) => l.unitId === unitId)
  const day = (offset: number) => addDays(today, offset)

  const planned = expandPlans(UNIT_PLANS)
    .map((s) => ({ ...s, checkIn: day(s.startOffset) }))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn) || a.unitCode.localeCompare(b.unitCode))

  const fromPlan = (s: PlannedStay & { checkIn: IsoDate }, i: number): Booking => {
    const unit = catalog.unitByCode(s.unitCode)
    const listing = listingOf(unit.id)
    const source = s.source === 'airbnb' && listing ? 'airbnb' : 'direct'
    const checkOut = addDays(s.checkIn, s.nights)
    const status = statusFor(s.checkIn, checkOut, today)
    const guest = GUESTS[(s.unitIndex * 7 + s.stayIndex) % GUESTS.length]
    if (!guest) throw new Error('Guest rotation is empty')
    return {
      id: `bk-${1000 + i}`,
      code: `BK-${1000 + i}`,
      guestId: guest.id,
      unitId: unit.id,
      requestedUnitId: unit.id,
      source,
      airbnbAccountId: source === 'airbnb' && listing ? listing.accountId : null,
      airbnbCode: source === 'airbnb' ? airbnbCode(1000 + i) : null,
      checkIn: s.checkIn,
      checkOut,
      nightlyRate: source === 'airbnb' ? unit.nightlyRate : round(unit.nightlyRate * 0.9, 10_000),
      status,
      notes: '',
      movements: [],
      createdOn: addDays(s.checkIn, source === 'airbnb' ? -21 : -9),
      checkedInOn: status === 'checked_in' || status === 'checked_out' ? s.checkIn : null,
      checkedOutOn: status === 'checked_out' ? checkOut : null,
      arrival: status === 'checked_in' || status === 'checked_out' ? { idVerified: true, deposit: 0, keysHanded: true, rulesExplained: true, arrivalTime: '14:00', adults: 2, children: 0, notes: '' } : null,
      departure: status === 'checked_out' ? { depositReturned: 0, extraCharges: 0, roomInspected: true, keysReturned: true, notes: '' } : null,
    }
  }

  const extras: Booking[] = EXTRA_BOOKINGS.map((e) => {
    const unit = catalog.unitByCode(e.unitCode)
    const checkIn = day(e.startOffset)
    return {
      id: e.id,
      code: e.code,
      guestId: e.guestId,
      unitId: unit.id,
      requestedUnitId: catalog.unitByCode(e.requestedUnitCode).id,
      source: e.source,
      airbnbAccountId: e.airbnbAccountId,
      airbnbCode: e.airbnbCode,
      checkIn,
      checkOut: addDays(checkIn, e.nights),
      nightlyRate: e.source === 'airbnb' ? unit.nightlyRate : round(unit.nightlyRate * 0.9, 10_000),
      status: e.status,
      notes: e.notes,
      movements: e.movements.map((m) => ({ fromUnitId: catalog.unitByCode(m.fromUnitCode).id, toUnitId: catalog.unitByCode(m.toUnitCode).id, on: day(m.onOffset), reason: m.reason })),
      createdOn: addDays(checkIn, -12),
      checkedInOn: null,
      checkedOutOn: null,
      arrival: null,
      departure: null,
    }
  })

  const transactions: Transaction[] = TRANSACTIONS.map((t) => ({
    id: `tx-${t.seq}`,
    number: `TX-${2400 + t.seq}`,
    accountId: t.accountId,
    kind: t.kind,
    categoryId: t.categoryId,
    amount: t.amount,
    date: day(-t.daysAgo),
    locationId: t.locationId,
    villaId: t.villaId,
    unitId: t.unitId,
    bookingId: t.bookingId,
    description: t.description,
    status: t.status,
    reversalOf: t.reversalOfSeq ? `tx-${t.reversalOfSeq}` : null,
    reversedBy: TRANSACTIONS.find((o) => o.reversalOfSeq === t.seq) ? `tx-${TRANSACTIONS.find((o) => o.reversalOfSeq === t.seq)?.seq}` : null,
    createdBy: PROFILE.name,
    createdOn: day(-t.daysAgo),
  }))

  const bookingsAll = [...planned.map(fromPlan), ...extras]
  const requests: ServiceRequest[] = SERVICE_REQUESTS.map((r) => {
    const unit = catalog.unitByCode(r.unitCode)
    const on = day(-r.daysAgo)
    const stay = r.withStay ? bookingsAll.find((b) => b.unitId === unit.id && (b.status === 'checked_in' || b.status === 'checked_out') && b.checkIn <= on && on < b.checkOut) : undefined
    return {
      id: `rq-${r.seq}`,
      number: `RQ-${100 + r.seq}`,
      unitId: unit.id,
      bookingId: stay?.id ?? null,
      kind: r.kind,
      priority: r.priority,
      note: r.note,
      charge: r.charge,
      status: r.status,
      assignee: r.assignee,
      requestedOn: on,
      requestedAt: r.at,
      doneOn: r.status === 'done' ? on : null,
      transactionId: null,
    }
  })

  const state: MockState = {
    today,
    locations: LOCATIONS.map((l) => ({ ...l })),
    villas: VILLAS.map((v) => ({ ...v })),
    units: UNITS.map((u) => ({ ...u })),
    groups: GROUPS.map((g) => ({ ...g })),
    catalog: () => buildCatalog(state.locations, state.villas, state.units, state.groups),
    accounts: AIRBNB_ACCOUNTS.map((a) => ({ ...a })),
    listings: LISTINGS.map((l) => ({ ...l })),
    guests: GUESTS.map(({ createdDaysAgo, ...g }) => ({ ...g, createdOn: day(-createdDaysAgo) })),
    bookings: bookingsAll,
    blocks: BLOCKS.map((k) => ({ id: k.id, unitId: catalog.unitByCode(k.unitCode).id, from: day(k.fromOffset), to: day(k.toOffset), reason: k.reason, note: k.note })),
    cashAccounts: CASH_ACCOUNTS.map(({ openedDaysAgo, ...a }) => ({ ...a, openedOn: day(-openedDaysAgo) })),
    categories: CATEGORIES.map((c) => ({ ...c })),
    transactions,
    requests,
    profile: { ...PROFILE },
    nextBooking: 3001,
    nextGuest: GUESTS.length + 1,
    nextTransaction: TRANSACTIONS.length + 1,
    nextBlock: BLOCKS.length + 1,
    nextCategory: CATEGORIES.length + 1,
    nextEntity: 1,
    nextRequest: SERVICE_REQUESTS.length + 1,
  }
  return state
}
