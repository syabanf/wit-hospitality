import type { Clock, Ports } from '@/application/ports'
import { canTransition, findConflicts, occupies, validateCheckIn, validateCheckOut, validateStay, type Booking, type UnitBlock } from '@/domain/booking'
import { validateAirbnbAccount, validateListing } from '@/domain/airbnb'
import { canEditRequest, canTransitionService, validateServiceRequest, type ServiceRequest } from '@/domain/roomService'
import { findById, RuleError } from '@/domain/errors'
import { canTransitionTransaction, validateAccount, validateTransaction, type CashAccount, type Transaction } from '@/domain/finance'
import type { Guest } from '@/domain/guest'
import { interchangeableWith, validateGroup, validateLocation, validateProperty, validateUnit, validateVilla } from '@/domain/property'
import { wait } from './helpers'
import { airbnbCode, buildState, restore, snapshot, type Snapshot } from './state'

/**
 * In-memory stand-in for the Go API. It enforces the same rules the backend owns
 * (overlap, lifecycle, posted money) and answers with the API's error codes.
 */
/** Where the demo keeps its changes for the day; the seed is rebuilt on a new day or a new seed version. */
export const DEMO_STORAGE_KEY = 'wit-demo-state'
const SEED_VERSION = 3

interface Store {
  load(): Snapshot | null
  save(s: Snapshot): void
}

function browserStore(today: string): Store | null {
  if (typeof localStorage === 'undefined') return null
  return {
    load() {
      try {
        const raw = localStorage.getItem(DEMO_STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as { version: number; today: string; state: Snapshot }
        return parsed.version === SEED_VERSION && parsed.today === today ? parsed.state : null
      } catch {
        return null
      }
    },
    save(state) {
      try {
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify({ version: SEED_VERSION, today, state }))
      } catch {
        // Storage full or blocked: the demo keeps running in memory.
      }
    },
  }
}

export function createMockPorts(clock: Clock, latency = 240, store: Store | null = browserStore(clock.today())): Ports {
  const s = buildState(clock.today())
  const saved = store?.load()
  if (saved) restore(s, saved)
  let pending = false
  /** Writes the tables once per tick, after the mutation that asked for it. */
  const persist = () => {
    if (!store || pending) return
    pending = true
    setTimeout(() => {
      pending = false
      store.save(snapshot(s))
    }, 0)
  }
  const later = async <T>(value: () => T): Promise<T> => {
    await wait(latency)
    const result = value()
    persist()
    return result
  }
  const copy = <T>(v: T): T => structuredClone(v)
  const today = () => clock.today()
  const catalog = () => s.catalog()
  const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const newId = (prefix: string, text: string) => `${prefix}-${slug(text) || 'x'}-${s.nextEntity++}`
  /** The first field error as the API would return it. */
  const refuse = (errors: Record<string, string | undefined>) => {
    const first = Object.values(errors).find(Boolean)
    if (first) throw new RuleError('VALIDATION_ERROR', first)
  }

  function createGuest(input: Omit<Guest, 'id' | 'createdOn'>): Guest {
    const guest: Guest = { ...input, id: `g-${String(s.nextGuest++).padStart(2, '0')}`, createdOn: today() }
    s.guests.push(guest)
    return guest
  }

  function assertFree(unitId: string, checkIn: string, checkOut: string, excludeId?: string) {
    const unit = catalog().unit(unitId)
    if (unit.status === 'inactive') throw new RuleError('UNIT_UNAVAILABLE', `${unit.code} is inactive.`)
    const conflicts = findConflicts(unitId, checkIn, checkOut, s.bookings, s.blocks, excludeId)
    const first = conflicts[0]
    if (first) throw new RuleError('BOOKING_OVERLAP', `${unit.code} is held by ${first.label} from ${first.from} to ${first.to}.`)
  }

  return {
    clock,
    property: {
      locations: () => later(() => copy(s.locations)),
      villas: () => later(() => copy(s.villas)),
      units: () => later(() => copy(s.units)),
      groups: () => later(() => copy(s.groups)),
      createLocation: (input) =>
        later(() => {
          refuse(validateLocation(input))
          const location = { id: newId('loc', input.name), name: input.name.trim(), area: input.area.trim() }
          s.locations.push(location)
          return copy(location)
        }),
      updateLocation: (id, input) =>
        later(() => {
          refuse(validateLocation(input))
          const location = findById(s.locations, id, 'location')
          Object.assign(location, { name: input.name.trim(), area: input.area.trim() })
          return copy(location)
        }),
      createVilla: (input) =>
        later(() => {
          refuse(validateVilla(input, s.villas))
          findById(s.locations, input.locationId, 'location')
          const villa = { id: newId('vil', input.name), ...input, name: input.name.trim(), description: input.description.trim() }
          s.villas.push(villa)
          return copy(villa)
        }),
      createProperty: (input) =>
        later(() => {
          refuse(validateProperty(input, s.villas, s.units))
          findById(s.locations, input.villa.locationId, 'location')
          const villa = { id: newId('vil', input.villa.name), ...input.villa, name: input.villa.name.trim(), description: input.villa.description.trim() }
          const groups = input.groups.map((g) => ({ id: newId('grp', g.name), villaId: villa.id, name: g.name.trim(), interchangeable: g.interchangeable }))
          const units = input.rooms.map((r) => ({
            id: `unit-${r.code.toLowerCase()}`,
            villaId: villa.id,
            groupId: r.groupIndex === null ? null : (groups[r.groupIndex]?.id ?? null),
            code: r.code,
            name: r.name.trim(),
            bedrooms: r.bedrooms,
            nightlyRate: r.nightlyRate,
            status: 'active' as const,
            amenities: r.amenities,
          }))
          s.villas.push(villa)
          s.groups.push(...groups)
          s.units.push(...units)
          return copy(villa)
        }),
      updateVilla: (id, input) =>
        later(() => {
          refuse(validateVilla(input, s.villas, id))
          const villa = findById(s.villas, id, 'villa')
          Object.assign(villa, { ...input, name: input.name.trim(), description: input.description.trim() })
          return copy(villa)
        }),
      createGroup: (input) =>
        later(() => {
          refuse(validateGroup(input))
          findById(s.villas, input.villaId, 'villa')
          const group = { id: newId('grp', input.name), ...input, name: input.name.trim() }
          s.groups.push(group)
          return copy(group)
        }),
      updateGroup: (id, input) =>
        later(() => {
          refuse(validateGroup(input))
          const group = findById(s.groups, id, 'unit group')
          Object.assign(group, { ...input, name: input.name.trim() })
          return copy(group)
        }),
      createUnit: (input) =>
        later(() => {
          refuse(validateUnit(input, s.units, s.groups))
          findById(s.villas, input.villaId, 'villa')
          const unit = { id: `unit-${input.code.toLowerCase()}`, ...input, name: input.name.trim() }
          s.units.push(unit)
          return copy(unit)
        }),
      updateUnit: (id, input) =>
        later(() => {
          refuse(validateUnit(input, s.units, s.groups, id))
          const unit = findById(s.units, id, 'unit')
          if (input.status === 'inactive' && unit.status !== 'inactive' && s.bookings.some((b) => b.unitId === id && occupies(b) && b.checkOut > today()))
            throw new RuleError('UNIT_IN_USE', `${unit.code} still has confirmed stays. Move or cancel them first.`)
          Object.assign(unit, { ...input, name: input.name.trim() })
          return copy(unit)
        }),
    },
    airbnb: {
      accounts: () => later(() => copy(s.accounts)),
      listings: () => later(() => copy(s.listings)),
      setListingStatus: (id, status) =>
        later(() => {
          const l = findById(s.listings, id, 'listing')
          l.status = status
          return copy(l)
        }),
      createAccount: (input) =>
        later(() => {
          refuse(validateAirbnbAccount(input, s.accounts))
          const account = { id: newId('acc', input.name), ...input, name: input.name.trim(), slot: Math.min(5, s.accounts.length + 2) }
          s.accounts.push(account)
          return copy(account)
        }),
      updateAccount: (id, input) =>
        later(() => {
          refuse(validateAirbnbAccount(input, s.accounts, id))
          const account = findById(s.accounts, id, 'Airbnb account')
          Object.assign(account, { ...input, name: input.name.trim() })
          return copy(account)
        }),
      createListing: (input) =>
        later(() => {
          refuse(validateListing(input, s.listings))
          findById(s.accounts, input.accountId, 'Airbnb account')
          const unit = catalog().unit(input.unitId)
          const listing = { id: `lst-${unit.code.toLowerCase()}`, ...input, title: input.title.trim() }
          s.listings.push(listing)
          return copy(listing)
        }),
      updateListing: (id, input) =>
        later(() => {
          refuse(validateListing(input, s.listings, id))
          const listing = findById(s.listings, id, 'listing')
          Object.assign(listing, { ...input, title: input.title.trim() })
          return copy(listing)
        }),
    },
    booking: {
      bookings: () => later(() => copy(s.bookings)),
      blocks: () => later(() => copy(s.blocks)),
      create: (input) =>
        later(() => {
          const problem = validateStay(input.checkIn, input.checkOut)
          if (problem) throw new RuleError('VALIDATION_ERROR', problem)
          // A draft may sit on held nights; confirming it runs the exclusion check.
          if (input.confirm) assertFree(input.unitId, input.checkIn, input.checkOut)
          const guestId = input.guestId ?? (input.newGuest ? createGuest(input.newGuest).id : null)
          if (!guestId) throw new RuleError('VALIDATION_ERROR', 'A booking needs a guest.')
          const n = s.nextBooking++
          const booking: Booking = {
            id: `bk-${n}`,
            code: `BK-${n}`,
            guestId,
            unitId: input.unitId,
            requestedUnitId: input.unitId,
            source: input.source,
            airbnbAccountId: input.source === 'airbnb' ? input.airbnbAccountId : null,
            airbnbCode: input.source === 'airbnb' ? (input.airbnbCode?.trim() || airbnbCode(n)) : null,
            checkIn: input.checkIn,
            checkOut: input.checkOut,
            nightlyRate: input.nightlyRate,
            status: input.confirm ? 'confirmed' : 'draft',
            notes: input.notes.trim(),
            movements: [],
            createdOn: today(),
            checkedInOn: null,
            checkedOutOn: null,
            arrival: null,
            departure: null,
          }
          s.bookings.push(booking)
          return copy(booking)
        }),
      transition: (id, to) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, to)) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot become ${to.replace('_', ' ')}.`)
          if (to === 'confirmed') assertFree(b.unitId, b.checkIn, b.checkOut, b.id)
          b.status = to
          if (to === 'checked_in') b.checkedInOn = today()
          if (to === 'checked_out') b.checkedOutOn = today()
          return copy(b)
        }),
      checkIn: (id, details) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, 'checked_in')) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot be checked in.`)
          refuse(validateCheckIn(details))
          b.status = 'checked_in'
          b.checkedInOn = today()
          b.arrival = { ...details, notes: details.notes.trim() }
          return copy(b)
        }),
      checkOut: (id, details) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (!canTransition(b, 'checked_out')) throw new RuleError('BOOKING_INVALID_STATE', `A ${b.status.replace('_', ' ')} booking cannot be checked out.`)
          refuse(validateCheckOut(details, b.arrival?.deposit ?? 0))
          b.status = 'checked_out'
          b.checkedOutOn = today()
          b.departure = { ...details, notes: details.notes.trim() }
          return copy(b)
        }),
      moveUnit: (id, unitId, reason) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status === 'checked_out' || b.status === 'cancelled') throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; nothing to move.')
          const target = catalog().unit(unitId)
          if (!interchangeableWith(catalog(), b.unitId).some((u) => u.id === unitId))
            throw new RuleError('UNIT_NOT_INTERCHANGEABLE', `${target.code} is not interchangeable with ${catalog().unit(b.unitId).code}.`)
          assertFree(unitId, b.checkIn, b.checkOut, b.id)
          b.movements = [...b.movements, { fromUnitId: b.unitId, toUnitId: unitId, on: today(), reason }]
          b.unitId = unitId
          return copy(b)
        }),
      adjustStay: (id, checkIn, checkOut) =>
        later(() => {
          const b = findById(s.bookings, id, 'booking')
          if (b.status === 'checked_out' || b.status === 'cancelled') throw new RuleError('BOOKING_INVALID_STATE', 'This stay is over; the dates are final.')
          if (b.status === 'checked_in' && checkIn !== b.checkIn) throw new RuleError('BOOKING_INVALID_STATE', 'The guest has checked in; only the check-out can move.')
          const problem = validateStay(checkIn, checkOut)
          if (problem) throw new RuleError('VALIDATION_ERROR', problem)
          assertFree(b.unitId, checkIn, checkOut, b.id)
          b.checkIn = checkIn
          b.checkOut = checkOut
          return copy(b)
        }),
      addBlock: (input) =>
        later(() => {
          const unit = catalog().unit(input.unitId)
          const clash = s.bookings.find((b) => b.unitId === input.unitId && occupies(b) && b.checkIn < input.to && input.from < b.checkOut)
          if (clash) throw new RuleError('BLOCK_OVERLAP', `${unit.code} has ${clash.code} on those nights. Move it before blocking.`)
          const block: UnitBlock = { ...input, id: `blk-${s.nextBlock++}`, note: input.note.trim() }
          s.blocks.push(block)
          return copy(block)
        }),
      removeBlock: (id) =>
        later(() => {
          findById(s.blocks, id, 'block')
          s.blocks = s.blocks.filter((k) => k.id !== id)
        }),
    },
    guest: {
      guests: () => later(() => copy(s.guests)),
      create: (input) => later(() => copy(createGuest(input))),
      update: (id, input) =>
        later(() => {
          const g = findById(s.guests, id, 'guest')
          Object.assign(g, input)
          return copy(g)
        }),
    },
    finance: {
      accounts: () => later(() => copy(s.cashAccounts)),
      createAccount: (input) =>
        later(() => {
          refuse(validateAccount(input, s.cashAccounts))
          const account: CashAccount = { id: newId('acc', input.name), ...input, name: input.name.trim(), locationId: input.kind === 'bank' ? input.locationId : input.locationId }
          s.cashAccounts.push(account)
          return copy(account)
        }),
      updateAccount: (id, input) =>
        later(() => {
          refuse(validateAccount(input, s.cashAccounts, id))
          const account = findById(s.cashAccounts, id, 'account')
          Object.assign(account, { ...input, name: input.name.trim() })
          return copy(account)
        }),
      categories: () => later(() => copy(s.categories)),
      transactions: () => later(() => copy(s.transactions)),
      createTransaction: (input, submit) =>
        later(() => {
          const errors = validateTransaction(input, s.categories)
          const first = Object.values(errors)[0]
          if (first) throw new RuleError('VALIDATION_ERROR', first)
          const seq = s.nextTransaction++
          const t: Transaction = {
            ...input,
            description: input.description.trim(),
            id: `tx-${seq}`,
            number: `TX-${2400 + seq}`,
            status: submit ? 'submitted' : 'draft',
            reversalOf: null,
            reversedBy: null,
            createdBy: s.profile.name,
            createdOn: today(),
          }
          s.transactions.push(t)
          return copy(t)
        }),
      transition: (id, to) =>
        later(() => {
          const t = findById(s.transactions, id, 'transaction')
          if (!canTransitionTransaction(t, to)) {
            if (t.status === 'posted' || t.status === 'reversed') throw new RuleError('TRANSACTION_ALREADY_POSTED', `${t.number} is ${t.status}; reverse it instead of editing it.`)
            throw new RuleError('TRANSACTION_INVALID_STATE', `A ${t.status} entry cannot become ${to}.`)
          }
          t.status = to
          return copy(t)
        }),
      reverse: (id, reason) =>
        later(() => {
          const t = findById(s.transactions, id, 'transaction')
          if (t.status !== 'posted') throw new RuleError('TRANSACTION_INVALID_STATE', `Only posted entries can be reversed; ${t.number} is ${t.status}.`)
          const seq = s.nextTransaction++
          const reversal: Transaction = {
            ...t,
            id: `tx-${seq}`,
            number: `TX-${2400 + seq}`,
            kind: t.kind === 'cash_in' ? 'cash_out' : 'cash_in',
            date: today(),
            description: `Reversal of ${t.number}: ${reason}`,
            status: 'posted',
            reversalOf: t.id,
            reversedBy: null,
            createdBy: s.profile.name,
            createdOn: today(),
          }
          t.status = 'reversed'
          t.reversedBy = reversal.id
          s.transactions.push(reversal)
          return copy(reversal)
        }),
      createCategory: (input) =>
        later(() => {
          const c = { id: `cat-${s.nextCategory++}`, name: input.name, kind: input.kind, slot: 0, active: true }
          s.categories.push(c)
          return copy(c)
        }),
      setCategoryActive: (id, active) =>
        later(() => {
          const c = findById(s.categories, id, 'category')
          c.active = active
          return copy(c)
        }),
    },
    service: {
      requests: () => later(() => copy(s.requests)),
      create: (input) =>
        later(() => {
          refuse(validateServiceRequest(input))
          catalog().unit(input.unitId)
          if (input.bookingId) findById(s.bookings, input.bookingId, 'booking')
          const now = new Date()
          const seq = s.nextRequest++
          const request: ServiceRequest = {
            ...input,
            note: input.note.trim(),
            id: `rq-${seq}`,
            number: `RQ-${100 + seq}`,
            status: 'open',
            assignee: '',
            requestedOn: today(),
            requestedAt: now.getHours() * 60 + now.getMinutes(),
            doneOn: null,
            transactionId: null,
          }
          s.requests.push(request)
          return copy(request)
        }),
      update: (id, input) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          if (!canEditRequest(r)) throw new RuleError('REQUEST_INVALID_STATE', `${r.number} is ${r.status}; it can no longer change.`)
          refuse(validateServiceRequest(input))
          Object.assign(r, { ...input, note: input.note.trim() })
          return copy(r)
        }),
      transition: (id, to) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          if (!canTransitionService(r, to)) throw new RuleError('REQUEST_INVALID_STATE', `A ${r.status.replace('_', ' ')} request cannot become ${to.replace('_', ' ')}.`)
          r.status = to
          if (to === 'done') r.doneOn = today()
          return copy(r)
        }),
      assign: (id, assignee) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          r.assignee = assignee.trim()
          return copy(r)
        }),
      linkTransaction: (id, transactionId) =>
        later(() => {
          const r = findById(s.requests, id, 'request')
          r.transactionId = transactionId
          return copy(r)
        }),
    },
    account: {
      profile: () => later(() => copy(s.profile)),
      saveProfile: (profile) =>
        later(() => {
          s.profile = { ...profile }
          return copy(s.profile)
        }),
    },
  }
}
