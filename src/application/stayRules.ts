import type { Action, Module, Permissions, User } from '@/domain/access'
import { sellsRoomType, validateStay, type Booking, type BookingSource, type UnitBlock } from '@/domain/booking'
import { findById } from '@/domain/errors'
import { overbookedNights, overbookLimit, validateOverbook, validateWalk, WALK_DESTINATION_LABEL, WALK_METHOD_LABEL, type OverbookedNight, type WalkInput } from '@/domain/overbooking'
import type { Catalog, Scope, Unit } from '@/domain/property'
import { unitsIn } from '@/domain/property'
import { evaluateStay, markTags, marksFrom, mayOverrideRestrictions, RESTRICTION_RULE_LABEL, restrictionLabel, restrictionWhen, unitRestrictions, validateRestriction, type BulkRestrictionInput, type Restriction, type RestrictionInput } from '@/domain/restriction'
import { addDays, maxIso, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { BookingView, ReportRow } from './views'

/** What the stay rule use cases borrow from the booking services. */
interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; permissions: Permissions; can: (module: Module, action: Action) => boolean }>
  world: () => Promise<{ cat: Catalog; bookings: Booking[]; blocks: UnitBlock[]; views: BookingView[]; describe: (b: Booking) => BookingView }>
  check: (errors: Record<string, string | undefined>) => void
  /** Closes a walked stay's links and gives back everything the guest paid. */
  refundAll: (bookingId: string) => Promise<void>
}

/** A restriction with the names a list shows. */
export interface RestrictionView extends Restriction {
  groupName: string
  villaName: string
  unitCode: string | null
  label: string
  when: string
}

/** An overbooked night with its room type and villa. */
export interface OverbookedView extends OverbookedNight {
  groupName: string
  villaId: string
  villaName: string
}

export function createStayRulesServices(d: Deps) {
  async function rules() {
    const [cat, restrictions, overbooking] = await Promise.all([d.world().then((w) => w.cat), d.ports.stayRules.restrictions(), d.ports.stayRules.overbooking()])
    const groupIds = new Set(cat.groups.map((g) => g.id))
    const describe = (r: Restriction): RestrictionView => {
      const group = cat.group(r.groupId)
      return { ...r, groupName: group.name, villaName: cat.villa(group.villaId).name, unitCode: r.unitId ? cat.unit(r.unitId).code : null, label: restrictionLabel(r), when: restrictionWhen(r) }
    }
    return { cat, restrictions, overbooking, views: restrictions.filter((r) => groupIds.has(r.groupId)).map(describe) }
  }

  /** Every overbooked night in [from, to) of the room types in view. */
  function overbookedIn(cat: Catalog, bookings: readonly Booking[], blocks: readonly UnitBlock[], from: IsoDate, to: IsoDate): OverbookedView[] {
    return cat.groups.flatMap((g) => overbookedNights(cat, g.id, from, to, bookings, blocks).map((n) => ({ ...n, groupName: g.name, villaId: g.villaId, villaName: cat.villa(g.villaId).name }))).sort((a, b) => a.date.localeCompare(b.date) || a.groupName.localeCompare(b.groupName))
  }

  /** Units of other room types free for the whole stay: where a walked guest can stay with us. */
  const walkTargets = (cat: Catalog, b: Booking, bookings: readonly Booking[], blocks: readonly UnitBlock[]): Unit[] => {
    const own = cat.unit(b.unitId).groupId
    return cat.units.filter((u) => u.status === 'active' && u.groupId !== own && !bookings.some((x) => x.id !== b.id && x.unitId === u.id && x.unitAssigned && (x.status === 'confirmed' || x.status === 'checked_in') && x.checkIn < b.checkOut && b.checkIn < x.checkOut) && !blocks.some((k) => k.unitId === u.id && k.from < b.checkOut && b.checkIn < k.to))
  }

  return {
    /** The restrictions page: every restriction with its names, the room types to pick from, and the overbooking policies. */
    async overview() {
      const [r, a] = await Promise.all([rules(), d.access()])
      return {
        restrictions: [...r.views].sort((x, y) => x.villaName.localeCompare(y.villaName) || x.groupName.localeCompare(y.groupName) || x.from.localeCompare(y.from)),
        groups: r.cat.groups.map((g) => ({ group: g, villaName: r.cat.villa(g.villaId).name, sellsByType: sellsRoomType(g), overbook: overbookLimit(r.overbooking, g.id) })),
        mayEdit: a.can('property', 'edit'),
        today: d.today(),
      }
    },

    /** One room type's restrictions, its units for a unit rule, its overbooking policy and the next three weeks of marks. */
    async roomType(groupId: string) {
      const [r, a] = await Promise.all([rules(), d.access()])
      const group = r.cat.group(groupId)
      const now = d.today()
      return {
        restrictions: r.views.filter((x) => x.groupId === groupId),
        units: r.cat.units.filter((u) => u.groupId === groupId),
        sellsByType: sellsRoomType(group),
        overbook: overbookLimit(r.overbooking, groupId),
        marks: marksFrom(r.restrictions, { groupId, unitId: null }, now, 21),
        mayEdit: a.can('property', 'edit'),
      }
    },

    async save(id: string | null, input: RestrictionInput) {
      await d.allow('property', 'edit')
      d.check(validateRestriction(input))
      return d.ports.stayRules.saveRestriction(id, input)
    },
    async remove(id: string) {
      await d.allow('property', 'edit')
      return d.ports.stayRules.removeRestriction(id)
    },
    async bulk(input: BulkRestrictionInput) {
      await d.allow('property', 'edit')
      d.check({ ...validateRestriction(input), groupIds: input.groupIds.length ? undefined : 'Pick at least one room type.' })
      return d.ports.stayRules.bulkRestrictions(input)
    },
    async setOverbooking(groupId: string, limit: number) {
      await d.allow('property', 'edit')
      d.check({ limit: validateOverbook(limit) ?? undefined })
      return d.ports.stayRules.setOverbooking(groupId, limit)
    },

    /**
     * What a stay meets before it is saved: the rules it breaks, whether the signed-in person may sell
     * past them, and the marks on three weeks of dates from the check-in (or today) for the date picker.
     */
    async check(input: { unitId: string | null; groupId: string | null; checkIn: string; checkOut: string; source: BookingSource }) {
      const [cat, restrictions, a] = await Promise.all([d.world().then((w) => w.cat), d.ports.stayRules.restrictions(), d.access()])
      const groupId = input.unitId ? (cat.unit(input.unitId).groupId ?? null) : input.groupId
      const target = { groupId, unitId: input.unitId }
      const start = /^\d{4}-\d{2}-\d{2}$/.test(input.checkIn) ? maxIso(d.today(), addDays(input.checkIn, -3)) : d.today()
      const marks = groupId ? marksFrom(restrictions, target, start, 21) : []
      const violations = groupId && !validateStay(input.checkIn, input.checkOut) ? evaluateStay(restrictions, { ...target, checkIn: input.checkIn, checkOut: input.checkOut }) : []
      return { violations, channel: input.source !== 'direct', mayOverride: mayOverrideRestrictions(a.permissions, a.user.role), marks }
    },

    /** What assigning a room meets: the rules set on that unit alone, and whether the signed-in person may sell past them. */
    async assignCheck(bookingId: string, unitId: string) {
      const [w, restrictions, a] = await Promise.all([d.world(), d.ports.stayRules.restrictions(), d.access()])
      const b = findById(w.bookings, bookingId, 'booking')
      const violations = unitId ? evaluateStay(unitRestrictions(restrictions, unitId), { groupId: w.cat.unit(unitId).groupId ?? null, unitId, checkIn: b.checkIn, checkOut: b.checkOut }) : []
      return { violations, channel: b.source !== 'direct', mayOverride: mayOverrideRestrictions(a.permissions, a.user.role) }
    },

    /** Overbooked nights from `from` for `days`, in the villas the user may see. */
    async overbooked(from: IsoDate, days: number) {
      const w = await d.world()
      return overbookedIn(w.cat, w.bookings, w.blocks, from, addDays(from, days))
    },

    /** Per room type in the calendar window: its marks and overbooked nights. Unit rows get their own stop sell. */
    async calendar(units: readonly Unit[], days: readonly IsoDate[]) {
      const [w, restrictions] = await Promise.all([d.world(), d.ports.stayRules.restrictions()])
      const from = days[0] ?? d.today()
      const to = addDays(from, days.length)
      const over = overbookedIn(w.cat, w.bookings, w.blocks, from, to)
      const groupIds = [...new Set(units.map((u) => u.groupId).filter((g): g is string => Boolean(g)))]
      const typeRows = groupIds
        .map((groupId) => {
          const group = w.cat.group(groupId)
          const marks = marksFrom(restrictions, { groupId, unitId: null }, from, days.length).map(markTags)
          const overbooked = days.map((date) => over.find((n) => n.groupId === groupId && n.date === date)?.over ?? 0)
          return { groupId, name: group.name, villaId: group.villaId, marks, overbooked }
        })
        .filter((r) => r.marks.some((m) => m.length > 0) || r.overbooked.some((n) => n > 0))
      const stopSell: Record<string, boolean[]> = Object.fromEntries(units.filter((u) => restrictions.some((r) => r.unitId === u.id)).map((u) => [u.id, marksFrom(restrictions.filter((r) => r.unitId === u.id), { groupId: u.groupId, unitId: u.id }, from, days.length).map((m) => m.stopSell)]))
      return { typeRows, stopSell }
    },

    /** The booking page: the restriction note, the walk, and whether the stay can be walked now and where to. */
    async forBooking(id: string) {
      const [w, walks, a] = await Promise.all([d.world(), d.ports.stayRules.walks(), d.access()])
      const b = findById(w.bookings, id, 'booking')
      const now = d.today()
      const groupId = w.cat.unit(b.unitId).groupId
      const overbooked = groupId ? overbookedNights(w.cat, groupId, now, addDays(now, 1), w.bookings, w.blocks) : []
      const walkable = b.status === 'confirmed' && b.checkIn === now && overbooked.length > 0
      return {
        note: b.restrictionNote ?? null,
        walk: walks.find((x) => x.bookingId === id) ?? null,
        walkable: walkable && a.can('booking', 'edit'),
        targets: walkable ? walkTargets(w.cat, b, w.bookings, w.blocks).map((u) => ({ unit: u, villaName: w.cat.villa(u.villaId).name })) : [],
        over: overbooked[0]?.over ?? 0,
      }
    },

    /** Records the walk; an outside walk cancels the stay and gives back everything the guest paid. */
    async walk(id: string, input: WalkInput) {
      await d.allow('booking', 'edit')
      d.check(validateWalk(input))
      const result = await d.ports.stayRules.walk(id, input)
      if (input.destination === 'outside') await d.refundAll(id)
      return { booking: (await d.world()).describe(result.booking), walk: result.walk }
    },

    async reportRows(slug: string, from: IsoDate, to: IsoDate, scope: Scope): Promise<ReportRow[]> {
      const w = await d.world()
      const unitIds = new Set(unitsIn(w.cat, scope).map((u) => u.id))
      if (slug === 'guest-walks') {
        const [walks, transactions] = await Promise.all([d.ports.stayRules.walks(), d.ports.finance.transactions()])
        return walks
          .filter((x) => x.date >= from && x.date <= to && unitIds.has(x.fromUnitId))
          .sort((x, y) => x.date.localeCompare(y.date))
          .map((x) => {
            const b = w.views.find((v) => v.id === x.bookingId)
            const t = x.transactionId ? transactions.find((tx) => tx.id === x.transactionId) : undefined
            return { date: x.date, number: x.number, code: x.bookingCode, guest: b?.guestName ?? '', roomType: w.cat.group(x.groupId).name, destination: x.toUnitId ? `${w.cat.unit(x.toUnitId).code}, ${w.cat.villa(w.cat.unit(x.toUnitId).villaId).name}` : x.property || WALK_DESTINATION_LABEL[x.destination], cost: x.cost, method: x.cost ? WALK_METHOD_LABEL[x.method] : '', entry: t ? `${t.number} ${t.status}` : '', compensation: x.compensation, reason: x.reason, by: x.by }
          })
      }
      if (slug === 'restriction-overrides') {
        return w.views
          .filter((b) => b.restrictionNote && b.restrictionNote.on >= from && b.restrictionNote.on <= to && unitIds.has(b.unitId))
          .sort((x, y) => (x.restrictionNote?.on ?? '').localeCompare(y.restrictionNote?.on ?? ''))
          .map((b) => ({ date: b.restrictionNote?.on ?? '', code: b.code, guest: b.guestName, source: b.sourceLabel, unit: b.unitCode, checkIn: b.checkIn, nights: b.nights, kind: b.restrictionNote?.kind === 'override' ? 'Override' : 'Channel warning', rules: (b.restrictionNote?.rules ?? []).map((r) => RESTRICTION_RULE_LABEL[r]).join(', '), reason: b.restrictionNote?.reason ?? '', by: b.restrictionNote?.by ?? '' }))
      }
      return []
    },
  }
}
