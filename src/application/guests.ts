import type { Action, Module, User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById } from '@/domain/errors'
import {
  apoaRow,
  countryName,
  documentExpired,
  findDuplicates,
  foreignDataMissing,
  ID_TYPE_LABEL,
  isForeign,
  reportDueAt,
  reportOverdue,
  SEX_LABEL,
  unregisteredAdults,
  validateCompanion,
  VISA_TYPE_LABEL,
  type ApoaPerson,
  type CompanionInput,
  type ForeignReport,
  type Guest,
  type StayCompanion,
} from '@/domain/guest'
import { holdUntil, isClosedLost, validateLostItem, type LostFoundSettings, type LostItem, type LostItemInput, type LostMove } from '@/domain/lostFound'
import type { Catalog, Scope, UnitPlace } from '@/domain/property'
import { addDays, maxIso, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { BookingView, ReportRow } from './views'

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  world: () => Promise<{ cat: Catalog; bookings: Booking[]; guests: Guest[]; views: BookingView[] }>
  check: (errors: Record<string, string | undefined>) => void
}

/** One foreign adult on one stay, with what Immigration still needs and whether the desk sent it. */
export interface ForeignRow {
  key: string
  personId: string
  kind: 'guest' | 'companion'
  person: ApoaPerson
  booking: BookingView
  address: string
  /** APOA fields still empty; the report cannot go out until they are filled. */
  missing: string[]
  report: ForeignReport | null
  dueAt: string
  overdue: boolean
}

export interface LostItemView extends LostItem {
  villaName: string
  unitCode: string | null
  guestName: string | null
  bookingCode: string | null
  holdUntil: IsoDate
  /** Unclaimed past the holding period: it may be disposed of or donated. */
  holdOver: boolean
}

/** Device time as `YYYY-MM-DDTHH:MM`, against the console's today. */
const nowOn = (today: IsoDate) => {
  const d = new Date()
  return `${today}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const addressOf = (place: UnitPlace) => `${place.villa.name}, ${place.location.name}, ${place.location.area}`
const inScope = (place: UnitPlace, scope: Scope) => (!scope.villaId || place.villa.id === scope.villaId) && (!scope.locationId || place.location.id === scope.locationId) && (!scope.unitId || place.unit.id === scope.unitId)

/** Foreign guest registration for Immigration, companions, duplicates, the blacklist and lost and found. */
export function createGuestServices({ ports, today, allow, world, check }: Deps) {
  /** Foreign adults on every stay that has checked in, lead guests and companions alike. */
  async function foreignWorld() {
    const [w, companions, reports] = await Promise.all([world(), ports.guest.companions(), ports.guest.foreignReports()])
    const now = nowOn(today())
    const rows: ForeignRow[] = w.views
      .filter((b) => (b.status === 'checked_in' || b.status === 'checked_out') && b.checkedInOn)
      .flatMap((b) => {
        const people: Array<{ personId: string; kind: ForeignRow['kind']; person: ApoaPerson }> = [
          { personId: b.guest.id, kind: 'guest', person: b.guest },
          ...companions.filter((c) => c.bookingId === b.id && c.adult).map((c) => ({ personId: c.id, kind: 'companion' as const, person: c })),
        ]
        const arrival = b.arrival?.arrivalTime ?? ''
        const checkedInOn = b.checkedInOn ?? b.checkIn
        return people
          .filter((p) => isForeign(p.person))
          .map((p) => {
            const report = reports.find((r) => r.bookingId === b.id && r.personId === p.personId) ?? null
            return { ...p, key: `${b.id}:${p.personId}`, booking: b, address: p.person.addressInIndonesia || addressOf(b.place), missing: foreignDataMissing(p.person), report, dueAt: reportDueAt(checkedInOn, arrival), overdue: !report && reportOverdue(checkedInOn, arrival, now) }
          })
      })
    return { w, companions, rows }
  }

  /** Who checked in that day or is in house that night, in the villa when one is picked. */
  const onDay = (rows: readonly ForeignRow[], date: IsoDate, villaId?: string) =>
    rows.filter(({ booking: b }) => {
      const inOn = b.checkedInOn ?? b.checkIn
      // A guest still in house past the booked morning stays on the list until checked out.
      const out = b.status === 'checked_in' ? maxIso(b.checkOut, addDays(today(), 1)) : (b.checkedOutOn ?? b.checkOut)
      return (!villaId || b.place.villa.id === villaId) && inOn <= date && (inOn === date || out > date)
    })

  const lostView = (i: LostItem, cat: Catalog, guests: readonly Guest[], bookings: readonly Booking[], settings: LostFoundSettings): LostItemView => {
    const until = holdUntil(i, settings)
    return {
      ...i,
      villaName: cat.villas.find((v) => v.id === i.villaId)?.name ?? i.villaId,
      unitCode: i.unitId ? (cat.units.find((u) => u.id === i.unitId)?.code ?? null) : null,
      guestName: i.guestId ? (guests.find((g) => g.id === i.guestId)?.name ?? null) : null,
      bookingCode: i.bookingId ? (bookings.find((b) => b.id === i.bookingId)?.code ?? null) : null,
      holdUntil: until,
      holdOver: !isClosedLost(i.status) && today() >= until,
    }
  }

  async function lostWorld() {
    const [w, items, settings] = await Promise.all([world(), ports.lostFound.items(), ports.lostFound.settings()])
    const villaIds = new Set(w.cat.villas.map((v) => v.id))
    const views = items.filter((i) => villaIds.has(i.villaId)).map((i) => lostView(i, w.cat, w.guests, w.bookings, settings))
    return { w, settings, views: views.sort((a, b) => b.foundOn.localeCompare(a.foundOn) || b.number.localeCompare(a.number)) }
  }

  const guest = {
    /** The Immigration list for one day and villa, with the APOA export rows. */
    async foreign(f: { date?: IsoDate; villaId?: string }) {
      await allow('guest', 'view')
      const date = f.date ?? today()
      const { w, rows } = await foreignWorld()
      const list = onDay(rows, date, f.villaId).sort((a, b) => Number(!!a.report) - Number(!!b.report) || a.booking.code.localeCompare(b.booking.code) || a.kind.localeCompare(b.kind))
      return { date, villas: w.cat.villas, rows: list, apoa: list.map((r) => apoaRow(r.person, { checkIn: r.booking.checkedInOn ?? r.booking.checkIn, checkOut: r.booking.checkOut, room: r.booking.unitCode, address: r.address })), today: today() }
    },
    /** Foreign guests whose report is past the 24 hours after check-in, for the bell. */
    async unreported() {
      const { rows } = await foreignWorld()
      return rows.filter((r) => r.overdue && r.booking.status === 'checked_in')
    },
    async markReported(bookingId: string, personIds: readonly string[], reference: string) {
      await allow('guest', 'edit')
      return ports.guest.markReported(bookingId, personIds, reference)
    },
    /** The lead guest and the companions of a stay, with what each still owes Immigration. */
    async registration(bookingId: string) {
      const [w, companions] = await Promise.all([world(), ports.guest.companions()])
      const b = findById(w.views, bookingId, 'booking')
      const people: Array<{ id: string; name: string; adult: boolean; doc: Guest | StayCompanion }> = [{ id: b.guest.id, name: b.guest.name, adult: true, doc: b.guest }, ...companions.filter((c) => c.bookingId === bookingId).map((c) => ({ id: c.id, name: c.name, adult: c.adult, doc: c }))]
      return {
        booking: b,
        /** Adults on the booking still unregistered: a warning at check-in, never a refusal. */
        unregistered: unregisteredAdults(b.arrival?.adults ?? b.partySize?.adults, people.filter((p) => p.adult).length),
        companions: companions.filter((c) => c.bookingId === bookingId),
        people: people.map((p) => ({ ...p, foreign: isForeign(p.doc), missing: p.adult ? foreignDataMissing(p.doc) : [], expired: p.adult && isForeign(p.doc) && documentExpired(p.doc, today()) })),
      }
    },
    async addCompanion(bookingId: string, input: CompanionInput) {
      await allow('guest', 'edit')
      check(validateCompanion(input))
      return ports.guest.addCompanion(bookingId, input)
    },
    async updateCompanion(id: string, input: CompanionInput) {
      await allow('guest', 'edit')
      check(validateCompanion(input))
      return ports.guest.updateCompanion(id, input)
    },
    async removeCompanion(id: string) {
      await allow('guest', 'edit')
      return ports.guest.removeCompanion(id)
    },
    /** Profile pairs sharing an email, phone or document number. */
    async duplicates() {
      const w = await world()
      return findDuplicates(w.guests)
    },
    async merge(keepId: string, dropId: string) {
      await allow('guest', 'edit')
      return ports.guest.merge(keepId, dropId)
    },
    async setBlacklist(id: string, reason: string | null) {
      await allow('guest', 'edit')
      return ports.guest.setBlacklist(id, reason)
    },
  }

  const lostFound = {
    async list() {
      await allow('guest', 'view')
      const { w, settings, views } = await lostWorld()
      return { items: views, settings, catalog: w.cat, guests: w.guests, stays: w.views.filter((b) => b.status === 'checked_in' || b.status === 'checked_out').sort((a, b) => b.checkIn.localeCompare(a.checkIn)), today: today() }
    },
    async create(input: LostItemInput) {
      await allow('guest', 'create')
      check(validateLostItem(input, today()))
      return ports.lostFound.create(input)
    },
    async update(id: string, input: LostItemInput) {
      await allow('guest', 'edit')
      check(validateLostItem(input, today()))
      return ports.lostFound.update(id, input)
    },
    async move(id: string, move: LostMove) {
      await allow('guest', 'edit')
      return ports.lostFound.move(id, move)
    },
    settings: () => ports.lostFound.settings(),
    async saveSettings(settings: LostFoundSettings) {
      await allow('guest', 'edit')
      return ports.lostFound.saveSettings(settings)
    },
  }

  /** The foreign guests report: everyone checked in during the range, in the APOA column order. */
  async function reportRows(from: IsoDate, to: IsoDate, scope: Scope): Promise<ReportRow[]> {
    const { rows } = await foreignWorld()
    return rows
      .filter((r) => inScope(r.booking.place, scope) && (r.booking.checkedInOn ?? '') >= from && (r.booking.checkedInOn ?? '') <= to)
      .sort((a, b) => (a.booking.checkedInOn ?? '').localeCompare(b.booking.checkedInOn ?? '') || a.booking.code.localeCompare(b.booking.code))
      .map((r) => ({
        name: r.person.name,
        sex: r.person.sex ? SEX_LABEL[r.person.sex] : '',
        birthPlace: r.person.birthPlace,
        birthDate: r.person.birthDate ?? '',
        nationality: countryName(r.person.nationality),
        document: ID_TYPE_LABEL[r.person.idType],
        number: r.person.idNumber,
        expiry: r.person.idExpiry ?? '',
        visa: r.person.visaType ? VISA_TYPE_LABEL[r.person.visaType] : '',
        entryDate: r.person.entryDate ?? '',
        entryPort: r.person.entryPort,
        address: r.address,
        checkIn: r.booking.checkedInOn ?? '',
        checkOut: r.booking.checkOut,
        room: r.booking.unitCode,
        code: r.booking.code,
        status: r.report ? 'Reported' : r.overdue ? 'Overdue' : 'Not yet reported',
        reportedBy: r.report ? `${r.report.reportedBy}, ${r.report.reportedAt.replace('T', ' ').slice(0, 16)}` : '',
      }))
  }

  return { guest, lostFound, reportRows }
}
