import type { VillaOpsPort } from '@/application/villaOpsPort'
import { can, ROLE_LABEL, type AuditAction, type Action, type Module, type User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import { findById, RuleError } from '@/domain/errors'
import { windowOf } from '@/domain/hospitality'
import type { PreventivePlan, WorkOrder } from '@/domain/maintenance'
import {
  assertAdjustable,
  assertWorkOrderable,
  chargeDescription,
  CHECK_KIND_LABEL,
  checkLines,
  checkNumber,
  itemsToCopy,
  lineWorkOrder,
  linesOff,
  validateCharge,
  validateCheck,
  validateUnitItem,
  type CheckLine,
  type InventoryCheck,
  type UnitItem,
} from '@/domain/unitInventory'
import { recordUpkeep, templatePlans, upkeepTask, UPKEEP_TEMPLATE_LABEL, validateApplyTemplate, validateUpkeep } from '@/domain/upkeep'
import { DEFAULT_LONG_STAY_NIGHTS, readingBill, utilityDescription, validateLongStay, validateMeter, validateReading, type Meter, type MeterReading } from '@/domain/utilities'
import type { IsoDate } from '@/lib/dates'
import type { MockState } from './state'

/** The mock API's shared helpers villa operations need. */
export interface VillaOpsContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  copy: <T>(v: T) => T
  today: () => IsoDate
  seq: (key: string) => number
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
  /** Posts a charge on a stay's folio in the actor's name, as billing does from an event. */
  postCharge: (b: Booking, code: string, description: string, amount: number) => void
  /** The mock's newWorkOrder. */
  openWorkOrder: (input: Pick<WorkOrder, 'villaId' | 'unitId' | 'source' | 'category' | 'priority' | 'title' | 'description'>) => WorkOrder
}

/** The stay in house on a plan's unit, or on any unit of its villa, as upkeep generation reads it. */
function upkeepStayFor(s: MockState, plan: Pick<PreventivePlan, 'villaId' | 'unitId'>) {
  const units = plan.unitId ? [plan.unitId] : s.units.filter((u) => u.villaId === plan.villaId).map((u) => u.id)
  const b = s.bookings.find((x) => x.status === 'checked_in' && units.includes(x.unitId))
  return b ? { bookingId: b.id, bookingCode: b.code, window: windowOf(b, 'villa') } : null
}

/** What generation does with an upkeep plan today: undefined for a plain plan, null to skip it. */
export function upkeepFor(s: MockState, plan: PreventivePlan, today: IsoDate) {
  if (!plan.upkeep) return undefined
  return upkeepTask({ ...plan, upkeep: plan.upkeep }, upkeepStayFor(s, plan), s.catalog().villa(plan.villaId).name, today)
}

export function createVillaOpsPort({ s, later, copy, today, seq, user, refuse, log, postCharge, openWorkOrder }: VillaOpsContext): VillaOpsPort {
  const require = (module: Module, action: Action, what: string) => {
    const me = user()
    if (!can(s.permissions, me.role, module, action)) throw new RuleError('FORBIDDEN', `${ROLE_LABEL[me.role]} cannot ${what}.`)
    return me
  }
  const unitCode = (unitId: string) => s.catalog().unit(unitId).code
  const listOf = (unitId: string) => s.unitItems.filter((i) => i.unitId === unitId)
  const line = (check: InventoryCheck, itemId: string): CheckLine => {
    const found = check.lines.find((l) => l.itemId === itemId)
    if (!found) throw new RuleError('NOT_FOUND', `${check.number} has no such item.`)
    return found
  }
  const patchLine = (check: InventoryCheck, itemId: string, change: Partial<CheckLine>) => {
    check.lines = check.lines.map((l) => (l.itemId === itemId ? { ...l, ...change } : l))
  }
  const settingsOf = (villaId: string) => s.utilitySettings.find((x) => x.villaId === villaId)?.longStayNights ?? DEFAULT_LONG_STAY_NIGHTS

  return {
    unitItems: () => later(() => copy(s.unitItems)),
    saveUnitItem: (id, input) =>
      later(() => {
        require('maintenance', 'edit', 'edit inventory lists')
        const current = id ? findById(s.unitItems, id, 'inventory item') : null
        const unit = s.catalog().unit(current?.unitId ?? input.unitId)
        refuse(validateUnitItem(input, listOf(unit.id), current))
        const fields = { name: input.name.trim(), category: input.category, expected: input.expected, condition: input.condition.trim(), photo: input.photo, replacementCost: input.replacementCost }
        if (current) {
          Object.assign(current, fields)
          log('update', 'unit-item', current.id, `Changed ${current.name} on the inventory of ${unit.code}`)
          return copy(current)
        }
        const item: UnitItem = { id: `uit-${seq('unitItem')}`, unitId: unit.id, villaId: unit.villaId, ...fields }
        s.unitItems.push(item)
        log('create', 'unit-item', item.id, `Added ${item.name} to the inventory of ${unit.code}`)
        return copy(item)
      }),
    removeUnitItem: (id) =>
      later(() => {
        require('maintenance', 'edit', 'edit inventory lists')
        const item = findById(s.unitItems, id, 'inventory item')
        s.unitItems = s.unitItems.filter((i) => i.id !== id)
        log('delete', 'unit-item', id, `Removed ${item.name} from the inventory of ${unitCode(item.unitId)}`)
      }),
    copyUnitItems: (fromUnitId, toUnitId) =>
      later(() => {
        require('maintenance', 'edit', 'edit inventory lists')
        const from = s.catalog().unit(fromUnitId)
        const to = s.catalog().unit(toUnitId)
        const fresh = itemsToCopy(listOf(from.id), listOf(to.id), { source: from.code, target: to.code }, from.id === to.id)
        for (const i of fresh) s.unitItems.push({ ...i, id: `uit-${seq('unitItem')}`, unitId: to.id, villaId: to.villaId, condition: '', photo: null })
        log('create', 'unit-item', to.id, `Copied ${fresh.length} items from ${from.code} to ${to.code}`)
        return copy(listOf(to.id))
      }),

    checks: () => later(() => copy(s.inventoryChecks)),
    recordCheck: (input) =>
      later(() => {
        const me = require('maintenance', 'edit', 'record inventory checks')
        const unit = s.catalog().unit(input.unitId)
        const list = listOf(unit.id)
        const b = findById(s.bookings, input.bookingId, 'booking')
        refuse(validateCheck(input, list, unit.code, b, s.inventoryChecks))
        const n = seq('inventoryCheck')
        const check: InventoryCheck = { id: `ick-${n}`, number: checkNumber(n), unitId: unit.id, villaId: unit.villaId, bookingId: b.id, bookingCode: b.code, kind: input.kind, on: today(), by: me.name, byId: me.id, lines: checkLines(input, list) }
        s.inventoryChecks.push(check)
        log('create', 'inventory-check', check.number, `Recorded ${CHECK_KIND_LABEL[check.kind].toLowerCase()} ${check.number} on ${unit.code} for ${b.code}: ${linesOff(check)} items off`)
        return copy(check)
      }),
    chargeLine: (checkId, itemId, input) =>
      later(() => {
        const me = require('booking', 'edit', 'charge a stay')
        const check = findById(s.inventoryChecks, checkId, 'inventory check')
        const l = line(check, itemId)
        const b = findById(s.bookings, check.bookingId, 'booking')
        refuse(validateCharge(check, l, input, b.status === 'checked_in'))
        const amount = l.replacementCost * input.quantity
        postCharge(b, 'DMG', chargeDescription(l, input.quantity, input.reason), amount)
        patchLine(check, itemId, { charge: { sourceRef: `${check.id}:${itemId}`, quantity: input.quantity, amount, reason: input.reason.trim(), by: me.name, on: today() } })
        log('create', 'inventory-check', check.number, `Charged ${l.name} on ${b.code}: ${amount}`)
        return copy(check)
      }),
    raiseWorkOrder: (checkId, itemId) =>
      later(() => {
        require('maintenance', 'create', 'raise work orders')
        const check = findById(s.inventoryChecks, checkId, 'inventory check')
        const l = line(check, itemId)
        assertWorkOrderable(l)
        const code = unitCode(check.unitId)
        const w = openWorkOrder({ villaId: check.villaId, unitId: check.unitId, source: 'inspection', priority: 'normal', ...lineWorkOrder(check, l, code) })
        patchLine(check, itemId, { workOrder: { id: w.id, number: w.number } })
        log('create', 'inventory-check', check.number, `Raised ${w.number} for ${l.name} from ${check.number}`)
        return copy(check)
      }),
    adjustLine: (checkId, itemId) =>
      later(() => {
        require('maintenance', 'edit', 'edit inventory lists')
        const check = findById(s.inventoryChecks, checkId, 'inventory check')
        const l = line(check, itemId)
        assertAdjustable(l)
        const item = s.unitItems.find((i) => i.id === itemId)
        if (item && l.counted === 0) s.unitItems = s.unitItems.filter((i) => i.id !== itemId)
        else if (item) item.expected = l.counted
        patchLine(check, itemId, { adjusted: true })
        log('update', 'unit-item', itemId, `Adjusted ${l.name} on the inventory of ${unitCode(check.unitId)} to ${l.counted}`)
        return copy(check)
      }),

    meters: () => later(() => copy(s.meters)),
    saveMeter: (id, input) =>
      later(() => {
        require('maintenance', id ? 'edit' : 'create', id ? 'edit meters' : 'add meters')
        const current = id ? findById(s.meters, id, 'meter') : null
        const villa = s.catalog().villa(current?.villaId ?? input.villaId)
        const unitVilla = (unitId: string) => s.units.find((u) => u.id === unitId)?.villaId
        refuse(validateMeter(input, villa, s.meters.filter((m) => m.villaId === villa.id), unitVilla, current))
        const fields = { unitId: input.unitId, kind: input.kind, number: input.number.trim(), unit: input.unit, tariff: input.tariff, payer: input.payer, active: input.active }
        if (current) {
          Object.assign(current, fields)
          log('update', 'meter', current.id, `Changed meter ${current.number} of ${villa.name}`)
          return copy(current)
        }
        const meter: Meter = { id: `mtr-${seq('meter')}`, villaId: villa.id, ...fields }
        s.meters.push(meter)
        log('create', 'meter', meter.id, `Added meter ${meter.number} to ${villa.name}`)
        return copy(meter)
      }),
    readings: () => later(() => copy(s.meterReadings)),
    recordReading: (input) =>
      later(() => {
        const me = require('maintenance', 'edit', 'record meter readings')
        const meter = findById(s.meters, input.meterId, 'meter')
        const readings = s.meterReadings.filter((r) => r.meterId === meter.id)
        const b = input.bookingId ? (s.bookings.find((x) => x.id === input.bookingId) ?? null) : null
        const serves = (unitId: string) => (meter.unitId ? meter.unitId === unitId : s.units.some((u) => u.id === unitId && u.villaId === meter.villaId))
        const { errors, previous, consumption } = validateReading(input, { meter, readings, today: today(), stay: b, longStayNights: settingsOf(meter.villaId), serves })
        refuse(errors)
        const reading: MeterReading = { id: `mrd-${seq('meterReading')}`, meterId: meter.id, villaId: meter.villaId, unitId: meter.unitId, on: input.on, value: input.value, photo: input.photo, purpose: input.purpose, bookingId: input.purpose === 'monthly' ? null : (b?.id ?? null), bookingCode: input.purpose === 'monthly' ? null : (b?.code ?? null), replacement: input.replacement, previous, consumption, amount: 0, billedTo: null, by: me.name, byId: me.id }
        const bill = readingBill(meter, reading, readings)
        if (bill) {
          Object.assign(reading, { amount: bill.amount, billedTo: bill.payer })
          if (bill.payer === 'guest' && b) postCharge(b, 'UTIL', utilityDescription(meter, bill.usage), bill.amount)
        }
        s.meterReadings.push(reading)
        log('create', 'meter-reading', reading.id, `Read ${meter.number} at ${reading.value} ${meter.unit} on ${reading.on}${bill ? `, billed ${bill.amount} to the ${bill.payer}` : ''}`)
        return copy(reading)
      }),
    utilitySettings: () => later(() => copy(s.villas.map((v) => ({ villaId: v.id, longStayNights: settingsOf(v.id) })))),
    saveUtilitySettings: (villaId, longStayNights) =>
      later(() => {
        require('property', 'edit', 'change property settings')
        const villa = s.catalog().villa(villaId)
        refuse(validateLongStay(longStayNights))
        const before = settingsOf(villaId)
        s.utilitySettings = [...s.utilitySettings.filter((x) => x.villaId !== villaId), { villaId, longStayNights }]
        log('update', 'utility-settings', villaId, `${villa.name} reads meters at check-in and check-out on stays of ${longStayNights} nights or more`, { longStayNights: before }, { longStayNights })
        return { villaId, longStayNights }
      }),

    applyTemplate: (input) =>
      later(() => {
        require('maintenance', 'create', 'add preventive plans')
        const villa = s.catalog().villa(input.villaId)
        const unitVilla = (unitId: string) => s.units.find((u) => u.id === unitId)?.villaId
        refuse(validateApplyTemplate(input, villa.name, unitVilla, s.plans))
        const plans = templatePlans(input).map((p) => ({ ...p, id: `plan-${seq('plan')}` }))
        s.plans.push(...plans)
        log('create', 'plan', villa.id, `Applied the ${UPKEEP_TEMPLATE_LABEL[input.template]} plans to ${villa.name}: ${plans.length} plans`)
        return copy(plans)
      }),
    recordUpkeep: (workOrderId, input) =>
      later(() => {
        require('maintenance', 'edit', 'work jobs')
        const w = findById(s.workOrders, workOrderId, 'work order')
        refuse(validateUpkeep(w, input))
        w.upkeep = recordUpkeep(w.upkeep!, input, today())
        log('update', 'work-order', w.number, `Recorded the checklist on ${w.number}${w.upkeep.readings ? `: pH ${w.upkeep.readings.ph}, chlorine ${w.upkeep.readings.chlorine}` : ''}`)
        return copy(w)
      }),
  }
}

