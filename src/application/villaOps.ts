import type { Action, Module, User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, NotFoundError, RuleError } from '@/domain/errors'
import type { PreventivePlan, WorkOrder } from '@/domain/maintenance'
import { unitKindOf, type Catalog } from '@/domain/property'
import { checkDiffs, validateUnitItem, type ChargeInput, type CheckInput, type CheckKind, type InventoryCheck, type UnitItemInput } from '@/domain/unitInventory'
import { validateApplyTemplate, validateUpkeep, type ApplyTemplateInput, type UpkeepInput } from '@/domain/upkeep'
import { consumptionByMonth, DEFAULT_LONG_STAY_NIGHTS, lastReading, METER_KINDS, validateLongStay, validateMeter, type Meter, type MeterInput, type MeterKind, type ReadingInput } from '@/domain/utilities'
import { addMonths, daysBetween as nightsOf, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'

interface Deps {
  ports: Ports
  today: () => IsoDate
  catalog: () => Promise<Catalog>
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; can: (module: Module, action: Action) => boolean }>
  check: (errors: Record<string, string | undefined>) => void
}

/** Months, oldest first, ending with the month of `today`. */
const lastMonths = (today: IsoDate, count: number) => Array.from({ length: count }, (_, i) => addMonths(`${today.slice(0, 7)}-01`, i - count + 1).slice(0, 7))

/**
 * Villa operations as the signed-in user may see them: inventory lists and checks, meters and
 * readings, and the upkeep plans. Contract: api/docs/contracts/villa-operations-contract.md.
 */
export function createVillaOpsServices({ ports, today, catalog, allow, access, check }: Deps) {
  const inScope = <T extends { villaId: string }>(cat: Catalog, list: readonly T[]) => {
    const ids = new Set(cat.villas.map((v) => v.id))
    return list.filter((x) => ids.has(x.villaId))
  }
  const preOf = (checks: readonly InventoryCheck[], c: InventoryCheck) => (c.kind === 'post_departure' ? (checks.find((x) => x.bookingId === c.bookingId && x.kind === 'pre_arrival') ?? null) : null)
  const settingsOf = async () => {
    const settings = await ports.villaOps.utilitySettings()
    return (villaId: string) => settings.find((x) => x.villaId === villaId)?.longStayNights ?? DEFAULT_LONG_STAY_NIGHTS
  }

  return {
    /** A unit's inventory list, the checks made on it, and the units it can copy a list from. */
    async unitInventory(unitId: string) {
      const [cat, items, checks, a] = await Promise.all([catalog(), ports.villaOps.unitItems(), ports.villaOps.checks(), access()])
      const unit = cat.unit(unitId)
      const others = cat.units.filter((u) => u.id !== unitId && items.some((i) => i.unitId === u.id))
      // Units of the same room type first: they are the template the list most likely follows.
      others.sort((x, y) => Number(y.groupId === unit.groupId) - Number(x.groupId === unit.groupId) || x.code.localeCompare(y.code))
      return {
        unit,
        items: items.filter((i) => i.unitId === unitId).sort((x, y) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name)),
        checks: checks.filter((c) => c.unitId === unitId).sort((x, y) => y.on.localeCompare(x.on) || y.number.localeCompare(x.number)),
        copyFrom: others.map((u) => ({ id: u.id, code: u.code, sameType: u.groupId !== null && u.groupId === unit.groupId })),
        canEdit: a.can('maintenance', 'edit'),
      }
    },
    async saveUnitItem(id: string | null, input: UnitItemInput) {
      await allow('maintenance', 'edit')
      const items = await ports.villaOps.unitItems()
      const current = id ? findById(items, id, 'inventory item') : null
      check(validateUnitItem(input, items.filter((i) => i.unitId === (current?.unitId ?? input.unitId)), current))
      return ports.villaOps.saveUnitItem(id, input)
    },
    async removeUnitItem(id: string) {
      await allow('maintenance', 'edit')
      return ports.villaOps.removeUnitItem(id)
    },
    async copyUnitItems(fromUnitId: string, toUnitId: string) {
      await allow('maintenance', 'edit')
      return ports.villaOps.copyUnitItems(fromUnitId, toUnitId)
    },

    /** The form of a new check: the unit's list, the stay, and the pre-arrival count a post-departure check compares with. */
    async checkForm(unitId: string, bookingId: string, kind: CheckKind) {
      await allow('maintenance', 'edit')
      const [cat, items, checks, bookings] = await Promise.all([catalog(), ports.villaOps.unitItems(), ports.villaOps.checks(), ports.booking.bookings()])
      const booking = findById(bookings, bookingId, 'booking')
      return {
        unit: cat.unit(unitId),
        villa: cat.villa(cat.unit(unitId).villaId),
        booking,
        kind,
        items: items.filter((i) => i.unitId === unitId),
        pre: kind === 'post_departure' ? (checks.find((c) => c.bookingId === bookingId && c.kind === 'pre_arrival') ?? null) : null,
        done: checks.find((c) => c.bookingId === bookingId && c.kind === kind) ?? null,
      }
    },
    async recordCheck(input: CheckInput) {
      await allow('maintenance', 'edit')
      return ports.villaOps.recordCheck(input)
    },

    /** One check with its differences, against the list and the stay's pre-arrival check. */
    async check(id: string) {
      const [cat, checks, bookings, a] = await Promise.all([catalog(), ports.villaOps.checks(), ports.booking.bookings(), access()])
      const c = checks.find((x) => x.id === id)
      if (!c || !cat.villas.some((v) => v.id === c.villaId)) throw new NotFoundError('inventory check', id)
      const booking = bookings.find((b) => b.id === c.bookingId) ?? null
      const pre = preOf(checks, c)
      return {
        check: c,
        pre,
        diffs: checkDiffs(c, pre),
        unit: cat.unit(c.unitId),
        villa: cat.villa(c.villaId),
        booking,
        inHouse: booking?.status === 'checked_in',
        can: { charge: a.can('booking', 'edit'), workOrder: a.can('maintenance', 'create'), adjust: a.can('maintenance', 'edit') },
      }
    },
    async chargeLine(checkId: string, itemId: string, input: ChargeInput) {
      await allow('booking', 'edit')
      return ports.villaOps.chargeLine(checkId, itemId, input)
    },
    async raiseWorkOrder(checkId: string, itemId: string) {
      await allow('maintenance', 'create')
      return ports.villaOps.raiseWorkOrder(checkId, itemId)
    },
    async adjustLine(checkId: string, itemId: string) {
      await allow('maintenance', 'edit')
      return ports.villaOps.adjustLine(checkId, itemId)
    },

    /** The checks of one stay, and whether its unit has a list to count. */
    async stayChecks(bookingId: string) {
      const [cat, items, checks, bookings, a] = await Promise.all([catalog(), ports.villaOps.unitItems(), ports.villaOps.checks(), ports.booking.bookings(), access()])
      const booking = findById(bookings, bookingId, 'booking')
      if (!cat.units.some((u) => u.id === booking.unitId)) throw new NotFoundError('booking', bookingId)
      const mine = checks.filter((c) => c.bookingId === bookingId)
      return {
        booking,
        unitCode: cat.units.find((u) => u.id === booking.unitId)?.code ?? '',
        hasList: items.some((i) => i.unitId === booking.unitId),
        pre: mine.find((c) => c.kind === 'pre_arrival') ?? null,
        post: mine.find((c) => c.kind === 'post_departure') ?? null,
        canRecord: a.can('maintenance', 'edit'),
      }
    },

    /** Today's villa arrivals and departures with their checks: the housekeeping inspection steps. */
    async villaChecksToday() {
      const [cat, items, checks, bookings, guests] = await Promise.all([catalog(), ports.villaOps.unitItems(), ports.villaOps.checks(), ports.booking.bookings(), ports.guest.guests()])
      const day = today()
      const unitIds = new Set(cat.units.filter((u) => unitKindOf(cat, u.id) === 'villa').map((u) => u.id))
      const row = (b: Booking, kind: CheckKind) => ({
        booking: b,
        kind,
        guestName: guests.find((g) => g.id === b.guestId)?.name ?? '',
        unitCode: cat.unit(b.unitId).code,
        hasList: items.some((i) => i.unitId === b.unitId),
        done: checks.find((c) => c.bookingId === b.id && c.kind === kind) ?? null,
      })
      const mine = bookings.filter((b) => unitIds.has(b.unitId) && b.unitAssigned !== false)
      return [
        ...mine.filter((b) => b.status === 'confirmed' && b.checkIn === day).map((b) => row(b, 'pre_arrival')),
        ...mine.filter((b) => b.status === 'checked_in' && b.checkOut === day).map((b) => row(b, 'post_departure')),
      ].sort((x, y) => x.unitCode.localeCompare(y.unitCode))
    },

    /** The Utilities page: meters, readings, monthly consumption per kind and per villa, and the long-stay setting. */
    async utilities() {
      const [cat, meters, readings, settings, a] = await Promise.all([catalog(), ports.villaOps.meters(), ports.villaOps.readings(), ports.villaOps.utilitySettings(), access()])
      const myMeters = inScope(cat, meters)
      const myReadings = inScope(cat, readings)
      const months = lastMonths(today(), 6)
      const ofMeter = (m: Meter) => myReadings.filter((r) => r.meterId === m.id)
      const unitCode = (id: string | null) => (id ? (cat.units.find((u) => u.id === id)?.code ?? '') : '')
      const meterRows = myMeters.map((m) => ({ ...m, villaName: cat.villa(m.villaId).name, unitCode: unitCode(m.unitId), last: lastReading(ofMeter(m)) }))
      const byKind = Object.fromEntries(METER_KINDS.map((k) => [k, consumptionByMonth(myReadings.filter((r) => myMeters.find((m) => m.id === r.meterId)?.kind === k), months)])) as Record<MeterKind, number[]>
      const perVilla = cat.villas
        .map((v) => {
          const rs = myReadings.filter((r) => r.villaId === v.id)
          const of = (k: MeterKind) => consumptionByMonth(rs.filter((r) => myMeters.find((m) => m.id === r.meterId)?.kind === k), months).reduce((s, x) => s + x, 0)
          return { villa: v, electricity: of('electricity'), water: of('water'), gas: of('gas'), billedGuest: rs.filter((r) => r.billedTo === 'guest').reduce((s, r) => s + r.amount, 0), billedOwner: rs.filter((r) => r.billedTo === 'owner').reduce((s, r) => s + r.amount, 0) }
        })
        .filter((row) => myMeters.some((m) => m.villaId === row.villa.id))
      const readingRows = [...myReadings]
        .sort((x, y) => y.on.localeCompare(x.on) || y.id.localeCompare(x.id, undefined, { numeric: true }))
        .map((r) => {
          const m = myMeters.find((x) => x.id === r.meterId)
          return { ...r, meterNumber: m?.number ?? '', kind: m?.kind ?? 'electricity', unit: m?.unit ?? 'kWh', villaName: cat.villa(r.villaId).name }
        })
      return {
        months,
        meters: meterRows,
        readings: readingRows,
        byKind,
        perVilla,
        settings: cat.villas.map((v) => ({ villa: v, longStayNights: settings.find((x) => x.villaId === v.id)?.longStayNights ?? DEFAULT_LONG_STAY_NIGHTS })),
        villas: cat.villas,
        units: cat.units,
        today: today(),
        can: { create: a.can('maintenance', 'create'), edit: a.can('maintenance', 'edit'), settings: a.can('property', 'edit') },
      }
    },
    async saveMeter(id: string | null, input: MeterInput) {
      await allow('maintenance', id ? 'edit' : 'create')
      const [cat, meters] = await Promise.all([catalog(), ports.villaOps.meters()])
      const current = id ? findById(meters, id, 'meter') : null
      const villa = cat.villa(current?.villaId ?? input.villaId)
      check(validateMeter(input, villa, meters.filter((m) => m.villaId === villa.id), (unitId) => cat.units.find((u) => u.id === unitId)?.villaId, current))
      return ports.villaOps.saveMeter(id, input)
    },
    async recordReading(input: ReadingInput) {
      await allow('maintenance', 'edit')
      check({ on: /^\d{4}-\d{2}-\d{2}$/.test(input.on) ? undefined : 'Pick the reading date.', value: Number.isFinite(input.value) && input.value >= 0 ? undefined : 'Enter the meter value.' })
      return ports.villaOps.recordReading(input)
    },
    async saveUtilitySettings(villaId: string, longStayNights: number) {
      await allow('property', 'edit')
      check(validateLongStay(longStayNights))
      return ports.villaOps.saveUtilitySettings(villaId, longStayNights)
    },

    /** A long stay's meters with their check-in and check-out readings; null when the stay is not long. */
    async stayMeters(bookingId: string) {
      const [cat, bookings, meters, readings, longStay, a] = await Promise.all([catalog(), ports.booking.bookings(), ports.villaOps.meters(), ports.villaOps.readings(), settingsOf(), access()])
      const b = findById(bookings, bookingId, 'booking')
      const unit = cat.units.find((u) => u.id === b.unitId)
      if (!unit) return null
      const threshold = longStay(unit.villaId)
      const nights = nightsOf(b.checkIn, b.checkOut)
      // Only a guest-paid meter bills the stay, so only those are read at its check-in and check-out.
      const mine = meters.filter((m) => m.active && m.payer === 'guest' && m.villaId === unit.villaId && (m.unitId === null || m.unitId === unit.id))
      if (nights < threshold || mine.length === 0) return null
      return {
        nights,
        threshold,
        booking: b,
        meters: mine.map((m) => ({ meter: m, checkIn: readings.find((r) => r.meterId === m.id && r.bookingId === b.id && r.purpose === 'check_in') ?? null, checkOut: readings.find((r) => r.meterId === m.id && r.bookingId === b.id && r.purpose === 'check_out') ?? null })),
        canRecord: a.can('maintenance', 'edit') && (b.status === 'confirmed' || b.status === 'checked_in'),
      }
    },

    async applyTemplate(input: ApplyTemplateInput): Promise<PreventivePlan[]> {
      await allow('maintenance', 'create')
      const [cat, plans] = await Promise.all([catalog(), ports.maintenance.plans()])
      check(validateApplyTemplate(input, cat.villa(input.villaId).name, (unitId) => cat.units.find((u) => u.id === unitId)?.villaId, plans))
      return ports.villaOps.applyTemplate(input)
    },
    async recordUpkeep(workOrderId: string, input: UpkeepInput): Promise<WorkOrder> {
      await allow('maintenance', 'edit')
      const w = findById(await ports.maintenance.workOrders(), workOrderId, 'work order')
      check(validateUpkeep(w, input))
      return ports.villaOps.recordUpkeep(workOrderId, input)
    },
    /** Sends a fogging task's notice to the guest in house as a free WhatsApp message, then stamps it sent. */
    async notifyStay(workOrderId: string): Promise<WorkOrder> {
      await allow('booking', 'edit')
      const w = findById(await ports.maintenance.workOrders(), workOrderId, 'work order')
      const notice = w.upkeep?.notice
      if (!notice) throw new RuleError('UPKEEP_NONE', `${w.number} has no notice for a stay.`)
      if (notice.sentOn) throw new RuleError('NOTICE_SENT', `The notice went to ${notice.bookingCode} on ${notice.sentOn}.`)
      await ports.messaging.send({ bookingId: notice.bookingId, channel: 'whatsapp', templateKey: null, language: 'en', body: notice.text })
      return ports.villaOps.recordUpkeep(workOrderId, { checklist: w.upkeep!.checklist.map((c) => c.done), readings: null, noticeSent: true })
    },
  }
}
