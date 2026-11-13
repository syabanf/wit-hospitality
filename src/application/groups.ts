import type { Action, Module, User } from '@/domain/access'
import { earns, nightsBetween, revenueBetween, type Booking, type CheckInDetails, type UnitBlock } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import { folioOwed, guestFolio, type GuestFolio } from '@/domain/folio'
import { arrivingStays, closesGroup, filterGroups, validateWholeVilla, wholeVillaTaken, type WholeVillaInput, GROUP_BILLING_LABEL, GROUP_STATUS_LABEL, GROUP_STATUSES, groupClashes, groupStatus, liveStay, masterFolio, stayOrder, stayPriceChange, validateGroup, validateGroupStay, type BookingGroup, type GroupDiscount, type GroupStayInput, type GroupStatus } from '@/domain/group'
import { groupFlow } from '@/domain/flow'
import { validateGuest, type Guest } from '@/domain/guest'
import { netPaid, validatePayment, type PaymentPolicy } from '@/domain/payment'
import type { PriceChange } from '@/domain/pricing'
import { listNight, priceListFor, type PriceList } from '@/domain/ratePlan'
import { wholeCapacity, wholeRentalProblem, wholeVillaUnits, type Catalog, type Scope, type Unit } from '@/domain/property'
import { maxIso, minIso, type IsoDate } from '@/lib/dates'
import type { GroupPaymentInput, GroupStayOverrides, NewBooking, NewBookingGroup, Ports } from './ports'
import type { BookingView, GroupRow, ReportRow } from './views'

/** What the group use cases borrow from the booking and payment services, so a group runs through the same paths. */
interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ can: (module: Module, action: Action) => boolean }>
  world: () => Promise<{ cat: Catalog; bookings: Booking[]; blocks: UnitBlock[]; guests: Guest[]; views: BookingView[]; describe: (b: Booking) => BookingView }>
  booking: {
    formOptions: () => Promise<{ catalog: Catalog; guests: Guest[]; today: IsoDate }>
    quote: (input: { unitId: string | null; groupId: string | null; checkIn: string; checkOut: string; source: NewBooking['source']; channelRate: number | null; price: PriceChange | null }) => Promise<{ price: { total: number; list: number; discount: number }; tax: { total: number }; beyondLimit: boolean; mayApprove: boolean; priceList: PriceList['kind'] | null } | null>
    checkIn: (id: string, details: CheckInDetails) => Promise<BookingView>
    transition: (id: string, to: 'cancelled') => Promise<BookingView>
  }
  payments: { policy: () => Promise<PaymentPolicy> }
  /** Throws the field map the form shows beside its fields. */
  check: (errors: Record<string, string | undefined>) => void
}

const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
const ended = (b: Pick<Booking, 'status'>) => b.status === 'cancelled' || b.status === 'no_show'

export function createGroupServices(d: Deps) {
  /** The groups with a stay in the villas the user may see, each with its stays and money. */
  async function groupWorld() {
    const [w, groups, payments] = await Promise.all([d.world(), d.ports.groups.groups(), d.ports.payment.payments()])
    const rowOf = (g: BookingGroup): GroupRow => {
      const stays = stayOrder(w.views.filter((b) => b.bookingGroupId === g.id))
      const earning = stays.filter(earns)
      const paid = sum(stays.map((b) => netPaid(payments, b.id)))
      return {
        group: g,
        leadName: w.guests.find((x) => x.id === g.leadGuestId)?.name ?? '',
        villaNames: g.villaIds.map((id) => w.cat.villas.find((v) => v.id === id)?.name ?? id).join(', '),
        stays,
        status: groupStatus(stays),
        checkIn: stays.reduce((m, b) => minIso(m, b.checkIn), stays[0]?.checkIn ?? d.today()),
        checkOut: stays.reduce((m, b) => maxIso(m, b.checkOut), stays[0]?.checkOut ?? d.today()),
        nights: sum(earning.map((b) => b.nights)),
        guests: sum(stays.filter((b) => !ended(b)).map((b) => (b.partySize ? b.partySize.adults + b.partySize.children : 0))),
        total: sum(earning.map((b) => b.total)),
        paid,
        outstanding: sum(stays.filter((b) => liveStay(b) || b.status === 'checked_out').map((b) => Math.max(0, b.total - netPaid(payments, b.id)))),
      }
    }
    const visible = groups.filter((g) => w.views.some((b) => b.bookingGroupId === g.id))
    return { w, groups: visible, payments, rowOf }
  }

  /** Every stay's whole folio and the part it pays itself; master billing moves the room lines to the group. */
  async function folios(g: BookingGroup, stays: readonly BookingView[], payments: Awaited<ReturnType<typeof groupWorld>>['payments']) {
    const [orders, tax] = await Promise.all([d.ports.orders.orders(), d.ports.ledger.taxSettings()])
    return Promise.all(
      stays.map(async (b) => {
        const postings = await d.ports.folio.postings(b.id)
        const sources = { booking: b, payments, orders, postings, tax }
        const whole = guestFolio(sources)
        const own: GuestFolio = g.billing === 'master' ? guestFolio({ ...sources, roomOnMaster: true }) : whole
        return { booking: b, whole, own }
      }),
    )
  }

  const groups = {
    async list() {
      const gw = await groupWorld()
      const rows = gw.groups.map(gw.rowOf).sort((a, b) => Number(!liveRow(a)) - Number(!liveRow(b)) || a.checkIn.localeCompare(b.checkIn))
      const counts = Object.fromEntries(['all', ...GROUP_STATUSES].map((s) => [s, s === 'all' ? rows.length : rows.filter((r) => r.status === s).length])) as Record<GroupStatus | 'all', number>
      return { rows, counts, today: d.today() }
    },

    async detail(id: string) {
      const gw = await groupWorld()
      const g = findById(gw.groups, id, 'group')
      const row = gw.rowOf(g)
      const [stays, policy, a] = await Promise.all([folios(g, row.stays, gw.payments), d.payments.policy(), d.access()])
      const master = g.billing === 'master' ? masterFolio(stays.map((x) => ({ booking: x.booking, folio: x.whole })), gw.payments) : null
      const mine = gw.payments.filter((p) => p.groupId === g.id)
      const batches = [...new Set(mine.map((p) => p.batch ?? p.id))].map((batch) => {
        const shares = mine.filter((p) => (p.batch ?? p.id) === batch)
        const [first] = shares
        return { batch, kind: first?.kind ?? 'deposit', method: first?.method ?? 'cash', status: first?.status ?? 'pending', paidOn: first?.paidOn ?? null, amount: sum(shares.map((p) => p.amount)), stays: shares.map((p) => row.stays.find((b) => b.id === p.bookingId)?.code ?? '') }
      })
      // Room due is zero on a master-billed stay; extras are its room service and charges.
      const rows = stays.map((x) => ({ booking: x.booking, roomDue: x.own.due.room, extras: folioOwed(x.own) - x.own.due.room, owed: folioOwed(x.own) }))
      const owed = master ? master.due + sum(rows.map((x) => x.extras)) : sum(rows.map((x) => x.owed))
      return {
        row,
        stays: rows,
        master,
        /** The group's own payments, one row per batch however many stays it split over. */
        batches,
        deposit: sum(batches.filter((b) => b.kind === 'deposit' && (b.status === 'paid' || b.status === 'refunded')).map((b) => b.amount)),
        owed,
        arriving: arrivingStays(row.stays, d.today()),
        flow: groupFlow(row.stays, { paid: row.paid, owed, firstEntryId: mine.find((p) => p.transactionId)?.transactionId ?? null }),
        policy,
        may: { edit: a.can('booking', 'edit'), pay: a.can('payments', 'create') },
        today: d.today(),
      }
    },

    async formOptions() {
      const [options, policy, a] = await Promise.all([d.booking.formOptions(), d.payments.policy(), d.access()])
      return { options, policy, mayApprove: a.can('booking', 'approve') }
    },

    /** Live check while the form is typed: the units that clash, and each stay's price with the group discount on it. */
    async check(stays: readonly GroupStayInput[], discount: GroupDiscount | null) {
      const w = await d.world()
      const quotes = await Promise.all(
        stays.map((st) =>
          d.booking
            .quote({ unitId: st.unitId, groupId: st.unitId ? null : st.roomTypeId, checkIn: st.checkIn, checkOut: st.checkOut, source: 'direct', channelRate: null, price: stayPriceChange(st.price, discount) })
            .then((q) => ({ quote: q, problem: null as string | null }))
            .catch((e: Error) => ({ quote: null, problem: e.message })),
        ),
      )
      return { clashes: groupClashes(w.cat, stays, w.bookings, w.blocks), quotes, total: sum(quotes.map((q) => q.quote?.tax.total ?? 0)) }
    },

    /** All or nothing: one unit taken refuses the whole group. The deposit is split over the stays in order. */
    async create(input: NewBookingGroup) {
      await d.allow('booking', 'create')
      const errors = validateGroup({ name: input.name, hasGuest: Boolean(input.guestId || input.newGuest), stays: input.stays, discount: input.discount })
      if (input.newGuest) for (const [k, v] of Object.entries(validateGuest(input.newGuest))) errors[`guest.${k}`] = v ?? ''
      if (input.deposit) {
        if (!Number.isInteger(input.deposit.amount) || input.deposit.amount <= 0) errors['deposit.amount'] = 'Enter the amount the group pays now.'
        if (input.deposit.method === 'bank_transfer' && input.deposit.reference.trim().length < 3) errors['deposit.reference'] = 'Enter the bank reference.'
      }
      d.check(errors)
      if (input.deposit) await d.allow('payments', 'create')
      return d.ports.groups.create(input)
    },

    /** The new stay meets the stay restrictions and the lead's blacklist; a manager may sell past either with a reason. */
    async addStay(id: string, stay: GroupStayInput, overrides?: GroupStayOverrides) {
      await d.allow('booking', 'edit')
      d.check(validateGroupStay(stay))
      const created = await d.ports.groups.addStay(id, stay, overrides)
      return (await d.world()).describe(created)
    },

    async removeStay(id: string, bookingId: string) {
      await d.allow('booking', 'edit')
      return (await d.world()).describe(await d.ports.groups.removeStay(id, bookingId))
    },

    /** What a whole villa rental books: its villas, what they sleep, the nightly price and any villa taken on the dates. */
    async wholeVillaCheck(villaId: string, checkIn: IsoDate, checkOut: IsoDate) {
      const [w, listings, plans] = await Promise.all([d.world(), d.ports.airbnb.listings(), d.ports.property.ratePlans()])
      const villa = w.cat.villa(villaId)
      const units = wholeVillaUnits(w.cat, villa)
      /** A villa's first night by the villa rule: its live listing, else its nightly rate, else the rate plan. */
      const firstNight = (u: Unit) => {
        const list = priceListFor(u, 'villa', listings.find((l) => l.unitId === u.id), plans)
        return list && checkIn ? listNight(list, u.nightlyRate, checkIn).rate : u.nightlyRate
      }
      return {
        villa,
        units,
        problem: wholeRentalProblem(villa),
        capacity: wholeCapacity(units),
        /** The whole villa's own rate, or each villa's own price on the first night added up. */
        nightly: villa.wholeNightlyRate > 0 ? villa.wholeNightlyRate : sum(units.map(firstNight)),
        taken: checkIn && checkOut && checkIn < checkOut ? wholeVillaTaken(units, checkIn, checkOut, w.bookings, w.blocks) : [],
      }
    },

    /** Every villa of the property for one party, as a group with one master bill. */
    async bookWholeVilla(input: WholeVillaInput) {
      await d.allow('booking', 'create')
      const errors = validateWholeVilla(input)
      if (input.newGuest) for (const [k, v] of Object.entries(validateGuest(input.newGuest))) errors[`guest.${k}`] = v ?? ''
      d.check(errors)
      return d.ports.groups.bookWholeVilla(input)
    },

    /** Checks in every stay arriving today or late, each with its own party; none goes in while one still waits for a room. */
    async checkIn(id: string, details: CheckInDetails) {
      await d.allow('booking', 'edit')
      const gw = await groupWorld()
      const row = gw.rowOf(findById(gw.groups, id, 'group'))
      const arriving = arrivingStays(row.stays, d.today())
      if (arriving.length === 0) throw new RuleError('GROUP_NOTHING_ARRIVING', `No stay of ${row.group.code} arrives today.`)
      const waiting = arriving.filter((b) => !b.unitAssigned)
      if (waiting.length) throw new RuleError('UNIT_UNASSIGNED', `Assign rooms to ${waiting.map((b) => b.code).join(', ')} before the group checks in.`)
      const done: BookingView[] = []
      for (const b of arriving) done.push(await d.booking.checkIn(b.id, { ...details, adults: b.partySize?.adults ?? details.adults, children: b.partySize?.children ?? details.children }))
      return done
    },

    /** Cancels every stay not yet in house; each stay's money follows the cancellation policy on its own. */
    async cancel(id: string) {
      await d.allow('booking', 'edit')
      const gw = await groupWorld()
      const row = gw.rowOf(findById(gw.groups, id, 'group'))
      const open = row.stays.filter((b) => b.status === 'draft' || b.status === 'confirmed')
      if (open.length === 0) throw new RuleError('BOOKING_INVALID_STATE', `${row.group.code} has no stay left to cancel; stays in house check out instead.`)
      for (const b of open) await d.booking.transition(b.id, 'cancelled')
      return open.length
    },

    /** One payment for the group, split over the stays in order; cash and transfer now, a gateway link otherwise. */
    async pay(id: string, input: GroupPaymentInput) {
      await d.allow('payments', 'create')
      const gw = await groupWorld()
      const row = gw.rowOf(findById(gw.groups, id, 'group'))
      d.check(validatePayment({ bookingId: row.stays[0]?.id ?? '', kind: input.kind, method: input.method, amount: input.amount, reference: input.reference, payer: '', note: input.note }, row.outstanding, 0))
      return d.ports.groups.pay(id, input)
    },

    /** The master folio's open balance for a stay of the group, and whether that stay is the last to leave. */
    async masterDue(id: string, bookingId: string) {
      const gw = await groupWorld()
      const g = findById(gw.groups, id, 'group')
      const row = gw.rowOf(g)
      const stays = await folios(g, row.stays, gw.payments)
      return { code: g.code, due: masterFolio(stays.map((x) => ({ booking: x.booking, folio: x.whole })), gw.payments).due, closes: closesGroup(row.stays, bookingId) }
    },

    /** Group bookings per villa for stays touching [from, end): nights, room revenue, deposit, paid and the balance. */
    async reportRows(from: IsoDate, end: IsoDate, scope: Scope): Promise<ReportRow[]> {
      const gw = await groupWorld()
      return gw.groups.flatMap((g) => {
        const row = gw.rowOf(g)
        const touching = row.stays.filter((b) => b.checkIn < end && b.checkOut > from && (!scope.villaId || b.place.villa.id === scope.villaId) && (!scope.locationId || b.place.location.id === scope.locationId) && (!scope.unitId || b.unitId === scope.unitId))
        return [...new Set(touching.map((b) => b.place.villa.id))].map((villaId) => {
          const mine = touching.filter((b) => b.place.villa.id === villaId)
          const paidOf = (b: Booking) => netPaid(gw.payments, b.id)
          return {
            code: g.code,
            name: g.name,
            villa: mine[0]?.place.villa.name ?? '',
            billing: GROUP_BILLING_LABEL[g.billing],
            stays: mine.length,
            checkIn: mine.reduce((m, b) => minIso(m, b.checkIn), mine[0]?.checkIn ?? from),
            nights: nightsBetween(mine, from, end),
            revenue: revenueBetween(mine, from, end),
            deposit: sum(gw.payments.filter((p) => p.groupId === g.id && p.kind === 'deposit' && (p.status === 'paid' || p.status === 'refunded') && mine.some((b) => b.id === p.bookingId)).map((p) => p.amount)),
            paid: sum(mine.map(paidOf)),
            balance: sum(mine.filter(earns).map((b) => Math.max(0, b.total - paidOf(b)))),
            status: GROUP_STATUS_LABEL[groupStatus(mine)],
          }
        })
      })
    },

    filter: filterGroups,
  }
  return groups
}

const liveRow = (r: GroupRow) => r.status !== 'checked_out' && r.status !== 'cancelled'
