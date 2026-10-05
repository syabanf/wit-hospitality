import { validateProfile, type Profile } from '@/domain/account'
import { DIRECT_SOURCE, sourceOptions, validateAirbnbAccount, validateListing, type AirbnbAccountInput, type ListingInput, type ListingStatus } from '@/domain/airbnb'
import {
  arrivalsOn,
  bookingTotal,
  departuresOn,
  findConflicts,
  inHouse,
  interchangeableFree,
  lifecycleSteps,
  nightState,
  nights,
  nightsBetween,
  occupancy,
  occupies,
  revenueBetween,
  sortBookings,
  SOURCE_LABEL,
  stripDays,
  swapTargets,
  validateCheckIn,
  validateCheckOut,
  validateStay,
  type Booking,
  type CheckInDetails,
  type CheckOutDetails,
  type BookingStatus,
  type UnitBlock,
} from '@/domain/booking'
import { buckets, change, periodRange, type DateRange } from '@/domain/dashboard'
import { findById, NotFoundError } from '@/domain/errors'
import {
  balance,
  byCategory,
  cashSummary,
  counts,
  signed,
  transactionSteps,
  validateAccount,
  validateTransaction,
  type CashAccountInput,
  type Transaction,
  type TransactionInput,
  type TransactionKind,
} from '@/domain/finance'
import { validateGuest, type GuestInput } from '@/domain/guest'
import { filterRequests, sortRequests, validateServiceRequest, type ServiceRequestInput, type ServiceStatus } from '@/domain/roomService'
import {
  buildCatalog,
  unitsIn,
  validateGroup,
  validateLocation,
  validateProperty,
  validateUnit,
  validateVilla,
  type Catalog,
  type GroupInput,
  type LocationInput,
  type PropertyInput,
  type Scope,
  type Unit,
  type UnitInput,
  type VillaInput,
} from '@/domain/property'
import { addDays, daysBetween, eachDay, shortDay, type IsoDate } from '@/lib/dates'
import type { BookingAction, NewBooking, Ports, TransactionAction } from './ports'
import type { BlockView, BookingView, CalendarRow, CalendarSpan, DashboardFilter, GuestRow, Metric, ServiceRequestView, TransactionView, UnitRow } from './views'

/** A thrown validation result: the form shows `errors` beside the fields. */
export class ValidationError extends Error {
  readonly errors: Record<string, string>
  constructor(errors: Record<string, string>) {
    super(Object.values(errors)[0] ?? 'Check the form.')
    this.name = 'ValidationError'
    this.errors = errors
  }
}

const TARGET_OCCUPANCY = 0.7
/** Throws the field map when a validator found something. */
function check(errors: Record<string, string | undefined>) {
  const found = Object.fromEntries(Object.entries(errors).filter((e): e is [string, string] => Boolean(e[1])))
  if (Object.keys(found).length) throw new ValidationError(found)
}
const metric = (value: number, previous: number): Metric => ({ value, previous, change: change(value, previous) })
const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)

export function createServices(ports: Ports) {
  const today = () => ports.clock.today()

  async function catalog(): Promise<Catalog> {
    const [locations, villas, units, groups] = await Promise.all([ports.property.locations(), ports.property.villas(), ports.property.units(), ports.property.groups()])
    return buildCatalog(locations, villas, units, groups)
  }

  /** Everything a booking row needs, loaded once per page. */
  async function bookingWorld() {
    const [cat, bookings, blocks, guests, accounts, listings] = await Promise.all([
      catalog(),
      ports.booking.bookings(),
      ports.booking.blocks(),
      ports.guest.guests(),
      ports.airbnb.accounts(),
      ports.airbnb.listings(),
    ])
    const describe = (b: Booking): BookingView => {
      const guest = findById(guests, b.guestId, 'guest')
      const place = cat.place(b.unitId)
      const account = b.airbnbAccountId ? findById(accounts, b.airbnbAccountId, 'Airbnb account') : null
      return {
        ...b,
        guest,
        guestName: guest.name,
        place,
        unitCode: place.unit.code,
        account,
        sourceLabel: account ? account.name : SOURCE_LABEL[b.source],
        nights: nights(b),
        total: bookingTotal(b),
      }
    }
    return { cat, bookings, blocks, guests, accounts, listings, views: bookings.map(describe), describe }
  }

  async function serviceWorld() {
    const [w, requests] = await Promise.all([bookingWorld(), ports.service.requests()])
    const describe = (r: (typeof requests)[number]): ServiceRequestView => {
      const booking = r.bookingId ? w.describe(findById(w.bookings, r.bookingId, 'booking')) : null
      const place = w.cat.place(r.unitId)
      return { ...r, place, unitCode: place.unit.code, booking, guestName: booking?.guestName ?? null }
    }
    return { ...w, requests, views: requests.map(describe), describeRequest: describe }
  }

  async function financeWorld() {
    const [cat, accounts, categories, transactions] = await Promise.all([catalog(), ports.finance.accounts(), ports.finance.categories(), ports.finance.transactions()])
    const describe = (t: Transaction): TransactionView => ({
      ...t,
      category: findById(categories, t.categoryId, 'category'),
      categoryName: findById(categories, t.categoryId, 'category').name,
      account: findById(accounts, t.accountId, 'account'),
      accountName: findById(accounts, t.accountId, 'account').name,
      location: cat.location(t.locationId),
      villa: t.villaId ? cat.villa(t.villaId) : null,
      unit: t.unitId ? cat.unit(t.unitId) : null,
    })
    return { cat, accounts, categories, transactions, views: transactions.map(describe), describe }
  }

  const inScope = (cat: Catalog, scope: Scope) => {
    const ids = new Set(unitsIn(cat, scope).map((u) => u.id))
    return (unitId: string) => ids.has(unitId)
  }
  const bySource = (source: string | undefined) => (b: Booking) =>
    !source || (source === DIRECT_SOURCE.id ? b.source === 'direct' : b.airbnbAccountId === source)

  function scopedTransactions(views: readonly TransactionView[], scope: Scope) {
    return views.filter((t) => {
      if (scope.unitId) return t.unitId === scope.unitId
      if (scope.villaId) return t.villaId === scope.villaId
      if (scope.locationId) return t.locationId === scope.locationId
      return true
    })
  }

  const dashboard = {
    async filterOptions() {
      const [cat, accounts] = await Promise.all([catalog(), ports.airbnb.accounts()])
      return { catalog: cat, sources: sourceOptions(accounts) }
    },

    async executive(f: DashboardFilter) {
      const w = await bookingWorld()
      const { current, previous } = periodRange(f.period, today(), f)
      const units = unitsIn(w.cat, f)
      const scoped = w.views.filter((b) => inScope(w.cat, f)(b.unitId)).filter(bySource(f.source))
      const rev = (r: DateRange) => revenueBetween(scoped, r.from, r.to)
      const sold = (r: DateRange) => nightsBetween(scoped, r.from, r.to)
      const occ = (r: DateRange) => occupancy(units, scoped, w.blocks, r.from, r.to).rate
      const avgRate = units.length ? sum(units.map((u) => u.nightlyRate)) / units.length : 0
      const activeUnits = units.filter((u) => u.status !== 'inactive').length
      const series = buckets(current, f.period).map((b) => ({
        ...b,
        revenue: rev(b),
        target: Math.round(activeUnits * daysBetween(b.from, b.to) * avgRate * TARGET_OCCUPANCY),
      }))
      const sources = sourceOptions(w.accounts).map((s) => ({
        ...s,
        value: revenueBetween(scoped.filter(bySource(s.id)), current.from, current.to),
      }))
      const byLocation = w.cat.locations.map((loc) => {
        const locUnits = units.filter((u) => w.cat.villa(u.villaId).locationId === loc.id)
        const locBookings = scoped.filter((b) => b.place.location.id === loc.id)
        return {
          location: loc,
          units: locUnits.length,
          occupancy: occupancy(locUnits, locBookings, w.blocks, current.from, current.to).rate,
          revenue: revenueBetween(locBookings, current.from, current.to),
        }
      }).filter((row) => row.units > 0)
      const horizon = addDays(today(), 7)
      const upcoming = scoped.filter((b) => b.status === 'confirmed' && b.checkIn >= today() && b.checkIn < horizon).sort((a, b) => a.checkIn.localeCompare(b.checkIn))
      const soldNow = sold(current)
      const soldPrev = sold(previous)
      return {
        range: current,
        revenue: metric(rev(current), rev(previous)),
        occupancy: metric(occ(current), occ(previous)),
        adr: metric(soldNow ? rev(current) / soldNow : 0, soldPrev ? rev(previous) / soldPrev : 0),
        nightsSold: metric(soldNow, soldPrev),
        onTarget: series.filter((s) => s.revenue >= s.target).length,
        series,
        sources: sources.filter((s) => s.value > 0),
        byLocation,
        upcoming: upcoming.slice(0, 6),
        unitCount: units.length,
      }
    },

    async operational(f: DashboardFilter) {
      const w = await bookingWorld()
      const now = today()
      const units = unitsIn(w.cat, f)
      const scoped = w.views.filter((b) => inScope(w.cat, f)(b.unitId)).filter(bySource(f.source))
      const states = units.map((u) => ({ unit: u, state: nightState(u, now, w.bookings, w.blocks) }))
      const days = stripDays(now, 14)
      const strip = w.cat.locations
        .map((loc) => ({
          location: loc,
          values: days.map((d) => units.filter((u) => w.cat.villa(u.villaId).locationId === loc.id && nightState(u, d, w.bookings, w.blocks) === 'occupied').length),
        }))
        .filter((row) => sum(row.values) > 0 || units.some((u) => w.cat.villa(u.villaId).locationId === row.location.id))
      const requests = sortRequests((await serviceWorld()).views.filter((r) => inScope(w.cat, f)(r.unitId) && (r.status === 'open' || r.status === 'in_progress')))
      const blocks: BlockView[] = w.blocks
        .filter((k) => inScope(w.cat, f)(k.unitId) && k.to > now)
        .map((k) => ({ ...k, place: w.cat.place(k.unitId) }))
        .sort((a, b) => a.from.localeCompare(b.from))
      return {
        today: now,
        days,
        arrivals: arrivalsOn(scoped, now),
        departures: departuresOn(scoped, now),
        inHouse: inHouse(scoped).sort((a, b) => a.checkOut.localeCompare(b.checkOut)),
        lateArrivals: scoped.filter((b) => b.status === 'confirmed' && b.checkIn < now),
        overstays: scoped.filter((b) => b.status === 'checked_in' && b.checkOut < now),
        available: states.filter((s) => s.state === 'free').length,
        blockedTonight: states.filter((s) => s.state === 'blocked').length,
        units: units.length,
        strip: { labels: days.map((d) => shortDay(d).replace(/^\w+ /, '')), total: days.map((d) => units.filter((u) => nightState(u, d, w.bookings, w.blocks) === 'occupied').length), byLocation: strip },
        blocks,
        requests,
      }
    },

    async financial(f: DashboardFilter) {
      const w = await financeWorld()
      const { current, previous } = periodRange(f.period, today(), f)
      const scoped = scopedTransactions(w.views, f)
      const weeks = buckets(current, f.period).map((b) => ({ ...b, ...cashSummary(scoped, b.from, b.to) }))
      const accounts = w.accounts
        .filter((a) => !f.locationId || a.locationId === f.locationId || a.locationId === null)
        .map((a) => ({ account: a, balance: balance(a, w.transactions), location: a.locationId ? w.cat.location(a.locationId) : null }))
      const pending = scoped.filter((t) => t.status === 'submitted' || t.status === 'approved')
      return {
        range: current,
        summary: cashSummary(scoped, current.from, current.to),
        previous: cashSummary(scoped, previous.from, previous.to),
        pending: { count: pending.length, amount: sum(pending.map((t) => t.amount)) },
        weeks,
        expenses: byCategory(scoped, w.categories, 'cash_out', current.from, current.to),
        income: byCategory(scoped, w.categories, 'cash_in', current.from, current.to),
        accounts,
        totalBalance: sum(accounts.map((a) => a.balance)),
        recent: [...scoped].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)).slice(0, 6),
      }
    },

    /** What the bell and the sidebar counts show. */
    async attention() {
      const [w, fin, sv] = await Promise.all([bookingWorld(), financeWorld(), serviceWorld()])
      const now = today()
      return {
        arrivals: arrivalsOn(w.views, now),
        late: w.views.filter((b) => b.status === 'confirmed' && b.checkIn < now),
        departures: departuresOn(w.views, now),
        pending: fin.views.filter((t) => t.status === 'submitted' || t.status === 'approved'),
        requests: sortRequests(sv.views.filter((r) => r.status === 'open' || r.status === 'in_progress')),
      }
    },
  }

  function unitRows(w: Awaited<ReturnType<typeof bookingWorld>>, units: readonly Unit[]): UnitRow[] {
    const now = today()
    return units.map((u) => {
      const listing = w.listings.find((l) => l.unitId === u.id) ?? null
      const next = w.views.filter((b) => b.unitId === u.id && b.status === 'confirmed' && b.checkIn >= now).sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0] ?? null
      return {
        place: w.cat.place(u.id),
        tonight: nightState(u, now, w.bookings, w.blocks),
        listing,
        account: listing ? findById(w.accounts, listing.accountId, 'Airbnb account') : null,
        nextArrival: next,
      }
    })
  }

  const last30 = () => ({ from: addDays(today(), -29), to: addDays(today(), 1) })

  const property = {
    async overview() {
      const w = await bookingWorld()
      const r = last30()
      const now = today()
      return {
        today: now,
        locations: w.cat.locations.map((loc) => {
          const villas = w.cat.villas.filter((v) => v.locationId === loc.id)
          const units = unitsIn(w.cat, { locationId: loc.id })
          const bookings = w.views.filter((b) => b.place.location.id === loc.id)
          return {
            location: loc,
            unitCount: units.length,
            occupiedTonight: units.filter((u) => nightState(u, now, w.bookings, w.blocks) === 'occupied').length,
            occupancy30: occupancy(units, bookings, w.blocks, r.from, r.to).rate,
            revenue30: revenueBetween(bookings, r.from, r.to),
            villas: villas.map((villa) => ({
              villa,
              groups: w.cat.groups.filter((g) => g.villaId === villa.id),
              units: unitRows(w, w.cat.units.filter((u) => u.villaId === villa.id)),
            })),
          }
        }),
      }
    },

    async villa(id: string) {
      const w = await bookingWorld()
      const villa = w.cat.villa(id)
      const r = last30()
      const units = w.cat.units.filter((u) => u.villaId === id)
      const bookings = w.views.filter((b) => b.place.villa.id === id)
      const now = today()
      return {
        villa,
        location: w.cat.location(villa.locationId),
        locations: w.cat.locations,
        groups: w.cat.groups.filter((g) => g.villaId === id).map((g) => ({ group: g, units: units.filter((u) => u.groupId === g.id) })),
        ungrouped: units.filter((u) => !u.groupId),
        units: unitRows(w, units),
        occupancy30: occupancy(units, bookings, w.blocks, r.from, r.to).rate,
        revenue30: revenueBetween(bookings, r.from, r.to),
        upcoming: bookings.filter((b) => b.status === 'confirmed' && b.checkIn >= now).sort((a, b) => a.checkIn.localeCompare(b.checkIn)).slice(0, 8),
        inHouse: inHouse(bookings),
      }
    },

    async unit(id: string) {
      const w = await bookingWorld()
      const place = w.cat.place(id)
      const r = last30()
      const now = today()
      const bookings = w.views.filter((b) => b.unitId === id)
      const listing = w.listings.find((l) => l.unitId === id) ?? null
      return {
        place,
        listing,
        account: listing ? findById(w.accounts, listing.accountId, 'Airbnb account') : null,
        strip: stripDays(now, 14).map((date) => ({ date, state: nightState(place.unit, date, w.bookings, w.blocks) })),
        tonight: nightState(place.unit, now, w.bookings, w.blocks),
        occupancy30: occupancy([place.unit], bookings, w.blocks, r.from, r.to).rate,
        revenue30: revenueBetween(bookings, r.from, r.to),
        upcoming: bookings.filter((b) => occupies(b) && b.checkOut > now).sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
        past: bookings.filter((b) => b.status === 'checked_out').length,
        blocks: w.blocks.filter((k) => k.unitId === id && k.to > now).sort((a, b) => a.from.localeCompare(b.from)),
        mates: place.group?.interchangeable ? w.cat.units.filter((u) => u.groupId === place.group?.id && u.id !== id) : [],
        groups: w.cat.groups.filter((g) => g.villaId === place.villa.id),
      }
    },

    async setGroupInterchangeable(id: string, interchangeable: boolean) {
      const group = findById(await ports.property.groups(), id, 'unit group')
      return ports.property.updateGroup(id, { villaId: group.villaId, name: group.name, interchangeable })
    },
    async createLocation(input: LocationInput) {
      check(validateLocation(input))
      return ports.property.createLocation(input)
    },
    async updateLocation(id: string, input: LocationInput) {
      check(validateLocation(input))
      return ports.property.updateLocation(id, input)
    },
    async createVilla(input: VillaInput) {
      check(validateVilla(input, await ports.property.villas()))
      return ports.property.createVilla(input)
    },
    async createProperty(input: PropertyInput) {
      const [villas, units] = await Promise.all([ports.property.villas(), ports.property.units()])
      check(validateProperty(input, villas, units))
      return ports.property.createProperty(input)
    },
    async updateVilla(id: string, input: VillaInput) {
      check(validateVilla(input, await ports.property.villas(), id))
      return ports.property.updateVilla(id, input)
    },
    async createGroup(input: GroupInput) {
      check(validateGroup(input))
      return ports.property.createGroup(input)
    },
    async updateGroup(id: string, input: GroupInput) {
      check(validateGroup(input))
      return ports.property.updateGroup(id, input)
    },
    async createUnit(input: UnitInput) {
      const [units, groups] = await Promise.all([ports.property.units(), ports.property.groups()])
      check(validateUnit(input, units, groups))
      return ports.property.createUnit(input)
    },
    async updateUnit(id: string, input: UnitInput) {
      const [units, groups] = await Promise.all([ports.property.units(), ports.property.groups()])
      check(validateUnit(input, units, groups, id))
      return ports.property.updateUnit(id, input)
    },
  }

  const airbnb = {
    async overview() {
      const w = await bookingWorld()
      const r = last30()
      const now = today()
      const airbnbBookings = w.views.filter((b) => b.source === 'airbnb')
      return {
        accounts: w.accounts.map((a) => {
          const mine = airbnbBookings.filter((b) => b.airbnbAccountId === a.id)
          return {
            account: a,
            listings: w.listings.filter((l) => l.accountId === a.id).length,
            bookings30: mine.filter((b) => b.checkIn >= r.from && b.checkIn < r.to && b.status !== 'cancelled').length,
            revenue30: revenueBetween(mine, r.from, r.to),
            upcoming: mine.filter((b) => b.status === 'confirmed' && b.checkIn >= now).length,
          }
        }),
        listings: w.listings.map((l) => ({
          listing: l,
          account: findById(w.accounts, l.accountId, 'Airbnb account'),
          place: w.cat.place(l.unitId),
          bookings30: airbnbBookings.filter((b) => b.unitId === l.unitId && b.checkIn >= r.from && b.checkIn < r.to && b.status !== 'cancelled').length,
          nextArrival: airbnbBookings.filter((b) => b.unitId === l.unitId && b.status === 'confirmed' && b.checkIn >= now).sort((a, b) => a.checkIn.localeCompare(b.checkIn))[0] ?? null,
        })),
        revenue30: revenueBetween(airbnbBookings, r.from, r.to),
        share30: (() => {
          const all = revenueBetween(w.views, r.from, r.to)
          return all ? revenueBetween(airbnbBookings, r.from, r.to) / all : 0
        })(),
      }
    },

    async account(id: string) {
      const w = await bookingWorld()
      const account = findById(w.accounts, id, 'Airbnb account')
      const bookings = sortBookings(w.views.filter((b) => b.airbnbAccountId === id), today())
      const r = last30()
      return {
        account,
        bookings30: bookings.filter((b) => b.checkIn >= r.from && b.checkIn < r.to && b.status !== 'cancelled').length,
        revenue30: revenueBetween(bookings, r.from, r.to),
        upcoming: bookings.filter((b) => b.status === 'confirmed' && b.checkIn >= today()).length,
        listings: w.listings.filter((l) => l.accountId === id).map((l) => ({ listing: l, place: w.cat.place(l.unitId) })),
        bookings: bookings.slice(0, 12),
        total: bookings.length,
      }
    },

    setListingStatus: (id: string, status: ListingStatus) => ports.airbnb.setListingStatus(id, status),
    async createAccount(input: AirbnbAccountInput) {
      check(validateAirbnbAccount(input, await ports.airbnb.accounts()))
      return ports.airbnb.createAccount(input)
    },
    async updateAccount(id: string, input: AirbnbAccountInput) {
      check(validateAirbnbAccount(input, await ports.airbnb.accounts(), id))
      return ports.airbnb.updateAccount(id, input)
    },
    async createListing(input: ListingInput) {
      check(validateListing(input, await ports.airbnb.listings()))
      return ports.airbnb.createListing(input)
    },
    async updateListing(id: string, input: ListingInput) {
      check(validateListing(input, await ports.airbnb.listings(), id))
      return ports.airbnb.updateListing(id, input)
    },
    async formOptions() {
      const [cat, accounts, listings] = await Promise.all([catalog(), ports.airbnb.accounts(), ports.airbnb.listings()])
      return { catalog: cat, accounts, listings }
    },
  }

  const booking = {
    async list() {
      const w = await bookingWorld()
      const now = today()
      const list = sortBookings(w.views, now)
      const counts = Object.fromEntries(['all', 'draft', 'confirmed', 'checked_in', 'checked_out', 'cancelled'].map((s) => [s, s === 'all' ? list.length : list.filter((b) => b.status === s).length])) as Record<BookingStatus | 'all', number>
      return {
        today: now,
        list,
        counts,
        sources: sourceOptions(w.accounts),
        arriving: arrivalsOn(list, now).length,
        inHouse: inHouse(list).length,
        departing: departuresOn(list, now).length,
        drafts: counts.draft,
      }
    },

    async detail(id: string) {
      const w = await bookingWorld()
      const b = w.describe(findById(w.bookings, id, 'booking'))
      const requests = sortRequests((await serviceWorld()).views.filter((r) => r.bookingId === id))
      return {
        booking: b,
        requests,
        cashbox: (await ports.finance.accounts()).find((a) => a.kind === 'cashbox' && a.locationId === b.place.location.id) ?? null,
        today: today(),
        steps: lifecycleSteps(b, today(), shortDay),
        swapTargets: swapTargets(b, w.cat, w.bookings, w.blocks),
        movements: b.movements.map((m) => ({ ...m, from: w.cat.unit(m.fromUnitId), to: w.cat.unit(m.toUnitId) })),
        others: sortBookings(w.views.filter((o) => o.guestId === b.guestId && o.id !== b.id), today()).slice(0, 4),
      }
    },

    async formOptions() {
      const w = await bookingWorld()
      return { catalog: w.cat, guests: [...w.guests].sort((a, b) => a.name.localeCompare(b.name)), accounts: w.accounts, listings: w.listings, today: today() }
    },

    /** Live check while a form is typed: conflicts, and interchangeable units that are free. */
    async availability(unitId: string, checkIn: string, checkOut: string, excludeId?: string) {
      const w = await bookingWorld()
      const problem = validateStay(checkIn, checkOut)
      if (problem) return { problem, conflicts: [], alternatives: [] as Unit[] }
      return {
        problem: null,
        conflicts: findConflicts(unitId, checkIn, checkOut, w.bookings, w.blocks, excludeId),
        alternatives: interchangeableFree(w.cat, unitId, checkIn, checkOut, w.bookings, w.blocks, excludeId),
      }
    },

    async create(input: NewBooking) {
      const errors: Record<string, string> = {}
      const stay = validateStay(input.checkIn, input.checkOut)
      if (stay) errors.checkOut = stay
      if (!input.unitId) errors.unitId = 'Pick a unit.'
      if (!input.guestId && !input.newGuest) errors.guestId = 'Pick a guest or add a new one.'
      if (input.newGuest) Object.assign(errors, Object.fromEntries(Object.entries(validateGuest(input.newGuest)).map(([k, v]) => [`guest.${k}`, v])))
      if (input.source === 'airbnb' && !input.airbnbAccountId) errors.airbnbAccountId = 'Pick the Airbnb account.'
      if (input.source === 'airbnb' && !(input.airbnbCode ?? '').trim()) errors.airbnbCode = 'Enter the Airbnb confirmation code.'
      if (!Number.isInteger(input.nightlyRate) || input.nightlyRate <= 0) errors.nightlyRate = 'Enter the nightly rate in whole rupiah.'
      if (Object.keys(errors).length) throw new ValidationError(errors)
      const created = await ports.booking.create(input)
      return (await bookingWorld()).describe(created)
    },

    async transition(id: string, to: BookingAction) {
      const b = await ports.booking.transition(id, to)
      return (await bookingWorld()).describe(b)
    },

    /** Front-desk check-in: the record, then the deposit as a submitted cash-in on the location's cashbox. */
    async checkIn(id: string, details: CheckInDetails) {
      check(validateCheckIn(details))
      const w = await bookingWorld()
      const b = w.describe(findById(w.bookings, id, 'booking'))
      const updated = await ports.booking.checkIn(id, details)
      if (details.deposit > 0) {
        const accounts = await ports.finance.accounts()
        const cashbox = accounts.find((a) => a.kind === 'cashbox' && a.locationId === b.place.location.id) ?? accounts[0]
        if (cashbox) {
          await ports.finance.createTransaction(
            { accountId: cashbox.id, kind: 'cash_in', categoryId: 'cat-deposit', amount: details.deposit, date: today(), locationId: b.place.location.id, villaId: b.place.villa.id, unitId: b.unitId, bookingId: id, description: `Security deposit, ${b.code} ${b.guestName}` },
            true,
          )
        }
      }
      return (await bookingWorld()).describe(updated)
    },

    /** Front-desk check-out: deposit returned as cash out, extra charges as cash in, both submitted for approval. */
    async checkOut(id: string, details: CheckOutDetails) {
      const w = await bookingWorld()
      const b = w.describe(findById(w.bookings, id, 'booking'))
      check(validateCheckOut(details, b.arrival?.deposit ?? 0))
      const updated = await ports.booking.checkOut(id, details)
      const accounts = await ports.finance.accounts()
      const cashbox = accounts.find((a) => a.kind === 'cashbox' && a.locationId === b.place.location.id) ?? accounts[0]
      if (cashbox) {
        const base = { accountId: cashbox.id, date: today(), locationId: b.place.location.id, villaId: b.place.villa.id, unitId: b.unitId, bookingId: id }
        if (details.depositReturned > 0) await ports.finance.createTransaction({ ...base, kind: 'cash_out', categoryId: 'cat-other', amount: details.depositReturned, description: `Deposit returned, ${b.code} ${b.guestName}` }, true)
        if (details.extraCharges > 0) await ports.finance.createTransaction({ ...base, kind: 'cash_in', categoryId: 'cat-extra', amount: details.extraCharges, description: `Departure charges, ${b.code} ${b.guestName}` }, true)
      }
      return (await bookingWorld()).describe(updated)
    },
    async moveUnit(id: string, unitId: string, reason: string) {
      if (reason.trim().length < 3) throw new ValidationError({ reason: 'Say why the guest moves.' })
      const b = await ports.booking.moveUnit(id, unitId, reason.trim())
      return (await bookingWorld()).describe(b)
    },
    async adjustStay(id: string, checkIn: string, checkOut: string) {
      const problem = validateStay(checkIn, checkOut)
      if (problem) throw new ValidationError({ checkOut: problem })
      const b = await ports.booking.adjustStay(id, checkIn, checkOut)
      return (await bookingWorld()).describe(b)
    },
    async addBlock(input: Omit<UnitBlock, 'id'>) {
      const problem = validateStay(input.from, input.to)
      if (problem) throw new ValidationError({ to: problem.replace('Check-out', 'The end').replace('check-in', 'the start') })
      return ports.booking.addBlock(input)
    },
    removeBlock: (id: string) => ports.booking.removeBlock(id),

    async calendar(from: IsoDate, days: number, scope: Scope) {
      const w = await bookingWorld()
      const to = addDays(from, days)
      const dayList = eachDay(from, to)
      const sources = sourceOptions(w.accounts)
      const slotOf = (b: Booking) => (b.source === 'direct' ? DIRECT_SOURCE.slot : (sources.find((s) => s.id === b.airbnbAccountId)?.slot ?? 0))
      const rows: CalendarRow[] = unitsIn(w.cat, scope).map((u) => {
        const place = w.cat.place(u.id)
        const spans: CalendarSpan[] = []
        for (const b of w.views.filter((b) => b.unitId === u.id && occupies(b) && b.checkIn < to && b.checkOut > from)) {
          const start = Math.max(0, daysBetween(from, b.checkIn))
          const end = Math.min(days, daysBetween(from, b.checkOut))
          spans.push({ kind: 'booking', id: b.id, start, length: end - start, label: b.guestName, slot: slotOf(b), status: b.status, clippedStart: b.checkIn < from, clippedEnd: b.checkOut > to })
        }
        for (const k of w.blocks.filter((k) => k.unitId === u.id && k.from < to && k.to > from)) {
          const start = Math.max(0, daysBetween(from, k.from))
          const end = Math.min(days, daysBetween(from, k.to))
          spans.push({ kind: 'block', id: k.id, start, length: end - start, label: k.note || k.reason, slot: 0, status: k.reason, clippedStart: k.from < from, clippedEnd: k.to > to })
        }
        return { place, spans: spans.sort((a, b) => a.start - b.start), states: dayList.map((d) => nightState(u, d, w.bookings, w.blocks)) }
      })
      const inWindow = (b: Booking) => b.checkIn < to && b.checkOut > from
      return {
        from,
        to,
        days: dayList,
        rows,
        today: today(),
        sources,
        stays: w.views.filter((b) => rows.some((r) => r.place.unit.id === b.unitId) && occupies(b) && inWindow(b)).sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
        blocks: w.blocks.filter((k) => rows.some((r) => r.place.unit.id === k.unitId) && k.from < to && k.to > from).map((k): BlockView => ({ ...k, place: w.cat.place(k.unitId) })),
      }
    },
  }

  function guestRows(w: Awaited<ReturnType<typeof bookingWorld>>): GuestRow[] {
    return w.guests.map((g) => {
      const mine = w.views.filter((b) => b.guestId === g.id && b.status !== 'cancelled' && b.status !== 'draft')
      const done = mine.filter((b) => b.status === 'checked_out' || b.status === 'checked_in')
      return {
        ...g,
        stays: mine.length,
        nights: sum(done.map((b) => b.nights)),
        spent: sum(done.map((b) => b.total)),
        lastStay: done.map((b) => b.checkIn).sort().at(-1) ?? null,
        inHouse: mine.some((b) => b.status === 'checked_in'),
      }
    })
  }

  const guest = {
    async list() {
      const w = await bookingWorld()
      return { guests: guestRows(w).sort((a, b) => (b.lastStay ?? '').localeCompare(a.lastStay ?? '') || a.name.localeCompare(b.name)) }
    },
    async detail(id: string) {
      const w = await bookingWorld()
      const row = guestRows(w).find((g) => g.id === id)
      if (!row) throw new NotFoundError('guest', id)
      return { guest: row, bookings: sortBookings(w.views.filter((b) => b.guestId === id), today()) }
    },
    async create(input: GuestInput) {
      check(validateGuest(input))
      return ports.guest.create(input)
    },
    async update(id: string, input: GuestInput) {
      check(validateGuest(input))
      return ports.guest.update(id, input)
    },
  }

  const finance = {
    async overview() {
      const w = await financeWorld()
      const r = last30()
      const prev = { from: addDays(r.from, -30), to: r.from }
      const accounts = w.accounts.map((a) => {
        const mine = w.views.filter((t) => t.accountId === a.id && counts(t)).sort((x, y) => y.date.localeCompare(x.date))
        return { account: a, balance: balance(a, w.transactions), location: a.locationId ? w.cat.location(a.locationId) : null, lastMovement: mine[0] ?? null, in30: cashSummary(mine, r.from, r.to) }
      })
      const pending = w.views.filter((t) => t.status === 'submitted' || t.status === 'approved').sort((a, b) => a.date.localeCompare(b.date))
      return {
        accounts,
        locations: w.cat.locations,
        total: sum(accounts.map((a) => a.balance)),
        summary: cashSummary(w.views, r.from, r.to),
        previous: cashSummary(w.views, prev.from, prev.to),
        pending,
        drafts: w.views.filter((t) => t.status === 'draft').length,
        recent: [...w.views].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)).slice(0, 8),
      }
    },

    async account(id: string) {
      const w = await financeWorld()
      const account = findById(w.accounts, id, 'account')
      const mine = w.views.filter((t) => t.accountId === id).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
      let running = account.openingBalance
      const ledger = mine.map((t) => {
        if (counts(t)) running += signed(t)
        return { ...t, running }
      })
      return { account, location: account.locationId ? w.cat.location(account.locationId) : null, locations: w.cat.locations, balance: running, ledger: ledger.reverse() }
    },

    async transactions() {
      const w = await financeWorld()
      const list = [...w.views].sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number))
      const counted = Object.fromEntries(['all', 'draft', 'submitted', 'approved', 'posted', 'reversed'].map((s) => [s, s === 'all' ? list.length : list.filter((t) => t.status === s).length]))
      return { list, counts: counted as Record<string, number>, categories: w.categories, accounts: w.accounts }
    },

    async transaction(id: string) {
      const [w, b] = await Promise.all([financeWorld(), bookingWorld()])
      const t = w.describe(findById(w.transactions, id, 'transaction'))
      const link = (ref: string | null) => (ref ? w.describe(findById(w.transactions, ref, 'transaction')) : null)
      return {
        transaction: t,
        steps: transactionSteps(t, shortDay),
        reversal: link(t.reversedBy),
        original: link(t.reversalOf),
        booking: t.bookingId ? b.describe(findById(b.bookings, t.bookingId, 'booking')) : null,
      }
    },

    async formOptions() {
      const [w, b] = await Promise.all([financeWorld(), bookingWorld()])
      const now = today()
      return {
        accounts: w.accounts,
        categories: w.categories.filter((c) => c.active),
        catalog: w.cat,
        bookings: b.views.filter((o) => o.status === 'confirmed' || o.status === 'checked_in' || (o.status === 'checked_out' && o.checkOut >= addDays(now, -14))),
        today: now,
      }
    },

    async createAccount(input: CashAccountInput) {
      check(validateAccount(input, await ports.finance.accounts()))
      return ports.finance.createAccount(input)
    },
    async updateAccount(id: string, input: CashAccountInput) {
      check(validateAccount(input, await ports.finance.accounts(), id))
      return ports.finance.updateAccount(id, input)
    },

    async createTransaction(input: TransactionInput, submit: boolean) {
      check(validateTransaction(input, await ports.finance.categories()))
      const t = await ports.finance.createTransaction(input, submit)
      return (await financeWorld()).describe(t)
    },
    async transition(id: string, to: TransactionAction) {
      const t = await ports.finance.transition(id, to)
      return (await financeWorld()).describe(t)
    },
    async reverse(id: string, reason: string) {
      if (reason.trim().length < 3) throw new ValidationError({ reason: 'Say why the entry is reversed.' })
      const t = await ports.finance.reverse(id, reason.trim())
      return (await financeWorld()).describe(t)
    },

    async categories() {
      const w = await financeWorld()
      const r = last30()
      return {
        categories: w.categories.map((c) => {
          const mine = w.views.filter((t) => t.categoryId === c.id && counts(t) && t.date >= r.from && t.date < r.to && !t.reversalOf)
          return { ...c, count30: mine.length, total30: sum(mine.map((t) => t.amount)) }
        }),
      }
    },
    async createCategory(input: { name: string; kind: TransactionKind }) {
      if (input.name.trim().length < 2) throw new ValidationError({ name: 'Enter the category name.' })
      const existing = await ports.finance.categories()
      if (existing.some((c) => c.name.toLowerCase() === input.name.trim().toLowerCase() && c.kind === input.kind)) throw new ValidationError({ name: `${input.name.trim()} already exists.` })
      return ports.finance.createCategory({ name: input.name.trim(), kind: input.kind })
    },
    setCategoryActive: (id: string, active: boolean) => ports.finance.setCategoryActive(id, active),
  }

  const service = {
    async list() {
      const w = await serviceWorld()
      const now = today()
      const list = sortRequests(w.views)
      return {
        today: now,
        list,
        open: list.filter((r) => r.status === 'open').length,
        inProgress: list.filter((r) => r.status === 'in_progress').length,
        doneToday: list.filter((r) => r.status === 'done' && r.doneOn === now).length,
        urgent: list.filter((r) => r.priority === 'urgent' && (r.status === 'open' || r.status === 'in_progress')).length,
        chargesOpen: list.filter((r) => r.charge > 0 && r.status !== 'cancelled' && !r.transactionId).reduce((s, r) => s + r.charge, 0),
      }
    },
    async detail(id: string) {
      const w = await serviceWorld()
      const r = w.describeRequest(findById(w.requests, id, 'request'))
      return { request: r, today: today(), cashbox: (await ports.finance.accounts()).find((a) => a.kind === 'cashbox' && a.locationId === r.place.location.id) ?? null }
    },
    async formOptions() {
      const w = await bookingWorld()
      return { catalog: w.cat, inHouse: inHouse(w.views), today: today() }
    },
    async create(input: ServiceRequestInput) {
      check(validateServiceRequest(input))
      const r = await ports.service.create(input)
      return (await serviceWorld()).describeRequest(r)
    },
    async update(id: string, input: ServiceRequestInput) {
      check(validateServiceRequest(input))
      return (await serviceWorld()).describeRequest(await ports.service.update(id, input))
    },
    async transition(id: string, to: Exclude<ServiceStatus, 'open'>) {
      const r = await ports.service.transition(id, to)
      return (await serviceWorld()).describeRequest(r)
    },
    async assign(id: string, assignee: string) {
      if (assignee.trim().length < 2) throw new ValidationError({ assignee: 'Enter who takes it.' })
      return (await serviceWorld()).describeRequest(await ports.service.assign(id, assignee))
    },
    /** Books the charge as a submitted cash-in on the location's cashbox and links it to the request. */
    async recordCharge(id: string) {
      const w = await serviceWorld()
      const r = w.describeRequest(findById(w.requests, id, 'request'))
      if (r.charge <= 0) throw new ValidationError({ charge: 'This request has no charge.' })
      if (r.transactionId) throw new ValidationError({ charge: 'The charge is already recorded.' })
      const accounts = await ports.finance.accounts()
      const cashbox = accounts.find((a) => a.kind === 'cashbox' && a.locationId === r.place.location.id) ?? accounts[0]
      if (!cashbox) throw new ValidationError({ charge: 'No cashbox to record the charge in.' })
      const t = await ports.finance.createTransaction(
        { accountId: cashbox.id, kind: 'cash_in', categoryId: 'cat-extra', amount: r.charge, date: today(), locationId: r.place.location.id, villaId: r.place.villa.id, unitId: r.unitId, bookingId: r.bookingId, description: `${r.number} ${r.note || r.kind}${r.guestName ? `, ${r.guestName}` : ''}` },
        true,
      )
      return (await serviceWorld()).describeRequest(await ports.service.linkTransaction(id, t.id))
    },
    filter: filterRequests,
  }

  /** Every master table on one page. */
  const master = {
    async all() {
      const [cat, accounts, listings, cashAccounts, categories] = await Promise.all([catalog(), ports.airbnb.accounts(), ports.airbnb.listings(), ports.finance.accounts(), ports.finance.categories()])
      return { catalog: cat, accounts, listings, cashAccounts, categories, today: today() }
    },
  }

  const account = {
    profile: () => ports.account.profile(),
    async saveProfile(profile: Profile) {
      check(validateProfile(profile))
      return ports.account.saveProfile(profile)
    },
  }

  return { clock: ports.clock, dashboard, property, airbnb, booking, guest, finance, service, master, account }
}

export type Services = ReturnType<typeof createServices>
