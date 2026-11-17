import type { Action, Module, User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import { filterLog, groupByShift, isOpenFollowUp, validateLog, type LogFilter, type LogInput } from '@/domain/logBook'
import { captureProblem, closedProblem, holdProblem, preAuthExpired, validatePreAuth, type DepositChoice, type PreAuthInput } from '@/domain/preAuth'
import type { Catalog } from '@/domain/property'
import { floorLabel } from '@/domain/section'
import { frontOfficeStay, isOpenDiscrepancy, stayPersons, validateResolve, validateRoomCheck, type ResolveInput, type RoomCheck, type RoomCheckInput } from '@/domain/roomCheck'
import { addDays, minIso, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { BookingView } from './views'

interface Deps {
  ports: Ports
  today: () => IsoDate
  catalog: () => Promise<Catalog>
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; can: (module: Module, action: Action) => boolean }>
  check: (errors: Record<string, string | undefined>) => void
  world: () => Promise<{ cat: Catalog; bookings: Booking[]; views: BookingView[] }>
  /** The stay's room balance on the folio, the forecast nights included: what a capture may take. */
  roomDue: (bookingId: string) => Promise<number>
}

/** How the round and the discrepancy list name a check. */
export interface CheckRow extends RoomCheck {
  unitCode: string
  villaName: string
  guestName: string | null
}

/** Room discrepancies, card holds and the log book: the front office controls. */
export function createFrontOfficeServices({ ports, today, catalog, allow, access, check, world, roomDue }: Deps) {
  /** Housekeeping reads the round, the desk reads the discrepancies; either may open the page. */
  async function allowRound() {
    const a = await access()
    if (!a.can('booking', 'view') && !a.can('maintenance', 'view')) throw new RuleError('FORBIDDEN', 'Your role cannot see the room report.')
    return a
  }

  async function checkRows() {
    const [w, checks] = await Promise.all([world(), ports.roomChecks.checks()])
    const guestOf = (bookingId: string | null) => w.views.find((b) => b.id === bookingId)?.guestName ?? null
    const unitIds = new Set(w.cat.units.map((u) => u.id))
    const rows: CheckRow[] = checks.filter((c) => unitIds.has(c.unitId)).map((c) => ({ ...c, unitCode: w.cat.unit(c.unitId).code, villaName: w.cat.villa(c.villaId).name, guestName: guestOf(c.bookingId) }))
    return { w, rows }
  }

  const roomReport = {
    /**
     * One property's round on a date: every unit with what the front office has now and what
     * housekeeping recorded, then the open discrepancies of every day and the ones resolved lately.
     */
    async page(villaId?: string, date?: IsoDate) {
      const a = await allowRound()
      const [{ w, rows }, businessDate] = await Promise.all([checkRows(), ports.audit.businessDate()])
      const villa = w.cat.villas.find((v) => v.id === villaId) ?? w.cat.villas[0]
      if (!villa) throw new RuleError('NOT_FOUND', 'No property is in your scope.')
      const day = date && date <= today() ? date : minIso(businessDate, today())
      const units = w.cat.units.filter((u) => u.villaId === villa.id && u.status !== 'inactive').sort((x, y) => x.code.localeCompare(y.code))
      const round = units.map((unit) => {
        const stay = frontOfficeStay(w.views, unit.id, day)
        return {
          unit,
          floor: unit.floor.trim() ? floorLabel(unit.floor) : '',
          front: stay ? { id: stay.id, code: stay.code, guestName: stay.guestName, persons: stayPersons(stay), checkOut: stay.checkOut } : null,
          check: rows.find((c) => c.unitId === unit.id && c.date === day) ?? null,
        }
      })
      const mine = rows.filter((c) => c.villaId === villa.id && c.date === day)
      return {
        date: day,
        today: today(),
        businessDate,
        villa,
        villas: w.cat.villas,
        round,
        counts: { rooms: units.length, checked: mine.length, open: mine.filter(isOpenDiscrepancy).length, resolved: mine.filter((c) => c.resolution).length },
        open: rows.filter(isOpenDiscrepancy),
        resolved: rows.filter((c) => c.resolution && c.date >= addDays(today(), -7)),
        canRecord: a.can('maintenance', 'edit'),
        canResolve: a.can('booking', 'edit'),
      }
    },
    async record(input: RoomCheckInput) {
      await allow('maintenance', 'edit')
      check(validateRoomCheck(input, today()))
      return ports.roomChecks.record({ ...input, persons: input.found === 'occupied' ? input.persons : null, note: input.note.trim() })
    },
    async resolve(id: string, input: ResolveInput) {
      await allow('booking', 'edit')
      const { rows } = await checkRows()
      const row = rows.find((c) => c.id === id)
      if (!row) throw new RuleError('NOT_FOUND', 'That room check was not found.')
      check(validateResolve(row, row.unitCode, input))
      return ports.roomChecks.resolve(id, { action: input.action, note: input.note.trim() })
    },
    /** Open discrepancies in scope, for the dashboard. */
    async open() {
      const a = await access()
      if (!a.can('booking', 'view') && !a.can('maintenance', 'view')) return []
      return (await checkRows()).rows.filter(isOpenDiscrepancy)
    },
  }

  const preAuths = {
    /** The stay's holds, newest first, with whether each lapsed and what a capture may take. */
    async forStay(bookingId: string) {
      const [a, all, due] = await Promise.all([access(), ports.preAuths.preAuths(), roomDue(bookingId)])
      const holds = all.filter((h) => h.bookingId === bookingId).reverse()
      return { holds: holds.map((h) => ({ ...h, expired: preAuthExpired(h, today()) })), roomDue: due, today: today(), canTake: a.can('payments', 'create') }
    },
    async take(input: PreAuthInput) {
      await allow('payments', 'create')
      const [w, all] = await Promise.all([world(), ports.preAuths.preAuths()])
      const b = findById(w.views, input.bookingId, 'booking')
      check(validatePreAuth(input, today()))
      const problem = holdProblem(b, all)
      if (problem) throw problem
      return ports.preAuths.create({ ...input, approvalCode: input.approvalCode.trim() })
    },
    /** The deposit step of the check-in form: the deposit is the hold, its errors land on the deposit field. */
    async takeAtCheckIn(bookingId: string, amount: number, card: DepositChoice['card']) {
      const input = { brand: 'visa' as const, last4: '', approvalCode: '', expiresOn: '', ...card, bookingId, amount }
      const { amount: deposit, ...errors } = validatePreAuth(input, today())
      check({ ...errors, deposit })
      return preAuths.take(input)
    },
    async capture(id: string, amount: number) {
      await allow('payments', 'create')
      const h = findById(await ports.preAuths.preAuths(), id, 'card hold')
      check(captureProblem(h, amount, await roomDue(h.bookingId), today()))
      return ports.preAuths.capture(id, amount)
    },
    async release(id: string) {
      await allow('payments', 'create')
      const closed = closedProblem(findById(await ports.preAuths.preAuths(), id, 'card hold'))
      if (closed) throw closed
      return ports.preAuths.release(id)
    },
  }

  /** Entries the person may see: every property's, and those of the properties in scope. */
  async function scopedEntries(cat: Catalog) {
    const villaIds = new Set(cat.villas.map((v) => v.id))
    return (await ports.logBook.entries()).filter((e) => e.villaId === null || villaIds.has(e.villaId))
  }

  const logBook = {
    /** Open follow-ups first, then the filtered entries by day and shift, with what the form links to. */
    async page(filter: LogFilter = {}) {
      const a = await allow('booking', 'view')
      const [w, shifts] = await Promise.all([world(), ports.cashier.shifts()])
      const entries = await scopedEntries(w.cat)
      const from = filter.from ?? addDays(today(), -6)
      const list = filterLog(entries, { ...filter, from })
      const stays = w.views.filter((b) => b.status === 'checked_in' || (b.status === 'confirmed' && b.checkIn <= addDays(today(), 1)))
      return {
        today: today(),
        me: a.id,
        from,
        followUps: entries.filter(isOpenFollowUp).sort((x, y) => x.at.localeCompare(y.at)),
        groups: groupByShift(list),
        total: list.length,
        villas: w.cat.villas,
        links: {
          bookings: stays.map((b) => ({ id: b.id, label: `${b.code} · ${b.guestName} · ${b.unitCode}` })),
          units: [...w.cat.units].sort((x, y) => x.code.localeCompare(y.code)).map((u) => ({ id: u.id, label: `${u.code} · ${w.cat.villa(u.villaId).name}` })),
          guests: stays.map((b) => ({ id: b.guestId, label: `${b.guestName} · ${b.code}` })),
        },
        /** The cashier shift that wrote each handover, for its link. */
        shifts: Object.fromEntries(shifts.filter((sh) => sh.logEntryId).map((sh) => [sh.logEntryId as string, { id: sh.id, number: sh.number }])),
        canWrite: (await access()).can('booking', 'edit'),
      }
    },
    async write(input: LogInput) {
      await allow('booking', 'edit')
      check(validateLog(input))
      return ports.logBook.write({ ...input, text: input.text.trim() })
    },
    async acknowledge(id: string) {
      await allow('booking', 'edit')
      return ports.logBook.acknowledge(id)
    },
    async done(id: string, note: string) {
      await allow('booking', 'edit')
      return ports.logBook.done(id, note.trim())
    },
    /** Open follow-ups in scope, for the dashboard. */
    async followUps() {
      const a = await access()
      if (!a.can('booking', 'view')) return []
      return (await scopedEntries(await catalog())).filter(isOpenFollowUp)
    },
  }

  return { roomReport, preAuths, logBook }
}

export type FrontOfficeServices = ReturnType<typeof createFrontOfficeServices>
