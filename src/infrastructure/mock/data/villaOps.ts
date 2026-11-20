import type { Booking } from '@/domain/booking'
import type { FolioPosting } from '@/domain/folio'
import type { PreventivePlan, WorkOrder } from '@/domain/maintenance'
import { ratesOn, stayMode, taxSplit } from '@/domain/tax'
import { chargeDescription, checkNumber, type CheckLine, type InventoryCategory, type InventoryCheck, type UnitItem } from '@/domain/unitInventory'
import { poolFlags, templatePlans, type UpkeepTemplate } from '@/domain/upkeep'
import { METER_UNIT_OF, readingBill, round2, utilityDescription, type Meter, type MeterKind, type MeterPayer, type MeterReading, type UtilitySettings } from '@/domain/utilities'
import { addDays, type IsoDate } from '@/lib/dates'
import type { MockState } from '../state'

/**
 * Villa operations seed (villa-operations-contract.md section 5): inventory lists on Villa Karang,
 * Tirta's pool suites and Saka's rooms; the pre-arrival and post-departure checks of the Karang
 * stay leaving today, one damaged glass charged; meters with three months of readings, Karang's
 * water on the owner and KR-01's electricity billed to that stay; pool, garden and fogging plans on
 * Karang and Tirta with a few tasks done.
 */

type ItemSeed = [name: string, category: InventoryCategory, expected: number, replacementCost: number]

const KARANG_ITEMS: readonly ItemSeed[] = [
  ['Wine glass', 'kitchen', 8, 120_000],
  ['Dinner plate', 'kitchen', 8, 85_000],
  ['Coffee machine', 'electronics', 1, 2_400_000],
  ['Smart TV', 'electronics', 2, 6_500_000],
  ['Bluetooth speaker', 'electronics', 1, 1_200_000],
  ['Bath towel', 'linen', 8, 180_000],
  ['Pool towel', 'linen', 6, 150_000],
  ['Bed sheet set', 'linen', 4, 650_000],
  ['Dining chair', 'furniture', 6, 1_100_000],
  ['Hair dryer', 'bathroom', 2, 450_000],
  ['Sun lounger', 'outdoor', 4, 3_200_000],
  ['Parasol', 'outdoor', 1, 2_800_000],
  ['Pool float', 'pool', 2, 350_000],
]

const SUITE_ITEMS: readonly ItemSeed[] = [
  ['Wine glass', 'kitchen', 4, 120_000],
  ['Kettle', 'electronics', 1, 650_000],
  ['Smart TV', 'electronics', 1, 6_500_000],
  ['Bath towel', 'linen', 4, 180_000],
  ['Pool towel', 'linen', 2, 150_000],
  ['Bathrobe', 'bathroom', 2, 420_000],
  ['Sun lounger', 'outdoor', 2, 3_200_000],
]

const ROOM_ITEMS: readonly ItemSeed[] = [
  ['Bath towel', 'linen', 2, 180_000],
  ['Hand towel', 'linen', 2, 70_000],
  ['Bathrobe', 'bathroom', 2, 420_000],
  ['Hair dryer', 'bathroom', 1, 450_000],
  ['Kettle', 'electronics', 1, 650_000],
  ['Smart TV', 'electronics', 1, 5_200_000],
  ['Tea cup', 'kitchen', 2, 60_000],
]

const LISTS: ReadonlyArray<[unitIds: readonly string[], items: readonly ItemSeed[]]> = [
  [['unit-kr-01', 'unit-kr-02', 'unit-kr-03'], KARANG_ITEMS],
  [['unit-tr-01', 'unit-tr-02'], SUITE_ITEMS],
  [['unit-sk-01', 'unit-sk-02', 'unit-sk-03', 'unit-sk-04', 'unit-sk-05', 'unit-sk-06', 'unit-sk-07', 'unit-sk-08'], ROOM_ITEMS],
]

type MeterSeed = [villaId: string, unitId: string | null, kind: MeterKind, number: string, tariff: number, payer: MeterPayer, start: number, monthly: readonly number[]]

const METERS: readonly MeterSeed[] = [
  ['vil-karang', 'unit-kr-01', 'electricity', 'PLN-KR-01', 1_700, 'guest', 18_020.4, [212.6, 187.0]],
  ['vil-karang', 'unit-kr-02', 'electricity', 'PLN-KR-02', 1_700, 'guest', 15_480, [176.3, 168.2]],
  ['vil-karang', 'unit-kr-03', 'electricity', 'PLN-KR-03', 1_700, 'guest', 16_905.5, [190.4, 201.1]],
  ['vil-karang', null, 'water', 'PDAM-KR', 9_500, 'owner', 1_240.5, [61.8, 58.8]],
  ['vil-tirta', null, 'electricity', 'PLN-TR', 1_450, 'operator', 42_310, [860.2, 812.7]],
  ['vil-tirta', null, 'water', 'PDAM-TR', 8_000, 'operator', 3_105.2, [96.4, 90.1]],
]

/** Readings about a month apart, the last ten days ago. */
const MONTHLY_DAYS = [-70, -40, -10]

export interface VillaOpsSeed {
  unitItems: UnitItem[]
  inventoryChecks: InventoryCheck[]
  meters: Meter[]
  meterReadings: MeterReading[]
  utilitySettings: UtilitySettings[]
  plans: PreventivePlan[]
  workOrders: WorkOrder[]
  postings: FolioPosting[]
  next: Record<string, number>
}

export function seedVillaOps(s: Pick<MockState, 'today' | 'bookings' | 'tax' | 'users' | 'next'>, signer: { staff: string; desk: string }): VillaOpsSeed {
  const today = s.today
  const day = (n: number) => addDays(today, n)
  const userId = (name: string) => s.users.find((u) => u.name === name)?.id ?? 'usr-kadek'
  let folio = s.next.folio ?? 1
  const postings: FolioPosting[] = []
  const post = (b: Booking, code: string, description: string, amount: number, by: string, at: string) => {
    const split = taxSplit(amount, code, ratesOn(s.tax, today), stayMode(b))
    const p: FolioPosting = { id: `fp-${folio++}`, bookingId: b.id, kind: 'charge', code, description, amount: split.net, service: split.service, pb1: split.pb1, date: today, part: 'charges', lineId: null, orderId: null, postedBy: by, postedById: userId(by), postedAt: `${today}T${at}`, approvedBy: null, transactionId: null }
    postings.push(p)
  }

  let itemSeq = 1
  const unitItems: UnitItem[] = LISTS.flatMap(([unitIds, items]) =>
    unitIds.flatMap((unitId) => items.map(([name, category, expected, replacementCost]) => ({ id: `uit-${itemSeq++}`, unitId, villaId: unitId.startsWith('unit-kr') ? 'vil-karang' : unitId.startsWith('unit-tr') ? 'vil-tirta' : 'vil-saka', name, category, expected, condition: '', photo: null, replacementCost }))),
  )

  // The Karang stay leaving today: counted on arrival, counted again this morning before check-out.
  const leaving = s.bookings.find((b) => b.unitId === 'unit-kr-01' && b.status === 'checked_in' && b.checkOut === today)
  const inventoryChecks: InventoryCheck[] = []
  if (leaving) {
    const list = unitItems.filter((i) => i.unitId === leaving.unitId)
    const lineOf = (i: UnitItem, counted = i.expected, condition: CheckLine['condition'] = 'ok', note = ''): CheckLine => ({ itemId: i.id, name: i.name, category: i.category, expected: i.expected, counted, condition, note, replacementCost: i.replacementCost, charge: null, workOrder: null, adjusted: false })
    const base = { unitId: leaving.unitId, villaId: 'vil-karang', bookingId: leaving.id, bookingCode: leaving.code, by: signer.staff, byId: userId(signer.staff) }
    inventoryChecks.push({ ...base, id: 'ick-1', number: checkNumber(1), kind: 'pre_arrival', on: leaving.checkIn, lines: list.map((i) => lineOf(i)) })
    const glass = list.find((i) => i.name === 'Wine glass')!
    const towel = list.find((i) => i.name === 'Pool towel')!
    const reason = 'Chipped during the stay; the guest agreed at check-out'
    const lines = list.map((i) => (i === glass ? lineOf(i, 8, 'damaged', 'One glass chipped at the rim') : i === towel ? lineOf(i, 5, 'missing', 'One pool towel not found') : lineOf(i)))
    const glassLine = lines.find((l) => l.itemId === glass.id)!
    glassLine.charge = { sourceRef: `ick-2:${glass.id}`, quantity: 1, amount: glass.replacementCost, reason, by: signer.desk, on: today }
    inventoryChecks.push({ ...base, id: 'ick-2', number: checkNumber(2), kind: 'post_departure', on: today, lines })
    post(leaving, 'DMG', chargeDescription(glassLine, 1, reason), glass.replacementCost, signer.desk, '09:40:00')
  }

  const meters: Meter[] = METERS.map(([villaId, unitId, kind, number, tariff, payer], i) => ({ id: `mtr-${i + 1}`, villaId, unitId, kind, number, unit: METER_UNIT_OF[kind], tariff, payer, active: true }))
  const meterReadings: MeterReading[] = []
  let readingSeq = 1
  const read = (meter: Meter, on: IsoDate, value: number, purpose: MeterReading['purpose'], b: Booking | null) => {
    const earlier = meterReadings.filter((r) => r.meterId === meter.id)
    const last = earlier[earlier.length - 1]
    const r: MeterReading = { id: `mrd-${readingSeq++}`, meterId: meter.id, villaId: meter.villaId, unitId: meter.unitId, on, value, photo: null, purpose, bookingId: b?.id ?? null, bookingCode: b?.code ?? null, replacement: false, previous: last ? last.value : null, consumption: last ? round2(value - last.value) : 0, amount: 0, billedTo: null, by: signer.staff, byId: userId(signer.staff) }
    const bill = readingBill(meter, r, earlier)
    if (bill) Object.assign(r, { amount: bill.amount, billedTo: bill.payer })
    meterReadings.push(r)
    return { r, bill }
  }
  METERS.forEach(([, , , , , , start, monthly], i) => {
    const meter = meters[i]!
    let value = start
    MONTHLY_DAYS.forEach((offset, k) => {
      if (k > 0) value = round2(value + monthly[k - 1]!)
      read(meter, day(offset), value, 'monthly', null)
    })
  })
  // KR-01 bills electricity on stays of five nights or more: the stay leaving today pays its usage.
  const utilitySettings: UtilitySettings[] = [{ villaId: 'vil-karang', longStayNights: 5 }]
  if (leaving) {
    const meter = meters[0]!
    const last = meterReadings.filter((r) => r.meterId === meter.id).at(-1)!
    read(meter, leaving.checkIn, round2(last.value + 34.6), 'check_in', leaving)
    const { bill } = read(meter, today, round2(last.value + 34.6 + 107.5), 'check_out', leaving)
    if (bill) post(leaving, 'UTIL', utilityDescription(meter, bill.usage), bill.amount, signer.staff, '09:15:00')
  }

  // Upkeep: Karang takes pool, garden and fogging; Tirta pool and garden. A few tasks done this week.
  let planSeq = s.next.plan ?? 1
  const due: Record<string, number> = { pool_daily: 0, pool_weekly: 2, pool_monthly: 12, garden_weekly: 1, garden_monthly: 20, fogging_monthly: 0 }
  const applied: ReadonlyArray<[string, UpkeepTemplate]> = [
    ['vil-karang', 'pool'],
    ['vil-karang', 'garden'],
    ['vil-karang', 'fogging'],
    ['vil-tirta', 'pool'],
    ['vil-tirta', 'garden'],
  ]
  const plans: PreventivePlan[] = applied.flatMap(([villaId, template]) =>
    templatePlans({ villaId, unitId: null, template, startOn: today }).map((p) => ({ ...p, id: `plan-${planSeq++}`, nextDue: day(due[p.upkeep!.key] ?? 0) })),
  )
  let woSeq = s.next.workOrder ?? 1
  const workOrders: WorkOrder[] = []
  const done = (plan: PreventivePlan, daysAgo: number, readings: { ph: number; chlorine: number } | null) => {
    const n = woSeq++
    const on = day(-daysAgo)
    const checklist = plan.checklist.map((item) => ({ item, done: true }))
    const history = [
      { kind: 'created' as const, by: 'Preventive plan', on, note: plan.checklist.join(' · ') },
      { kind: 'in_progress' as const, by: signer.staff, on, note: '' },
      { kind: 'done' as const, by: signer.staff, on, note: readings ? `pH ${readings.ph}, chlorine ${readings.chlorine}` : '' },
    ]
    workOrders.push({
      id: `wo-${n}`, number: `WO-${500 + n}`, villaId: plan.villaId, unitId: null, assetId: null, planId: plan.id, source: 'preventive', category: plan.category, priority: 'normal', title: plan.title, description: plan.checklist.join(' · '), reportedBy: 'Preventive plan',
      assigneeId: null, vendorId: null, status: 'done', createdOn: on, scheduledOn: on, startedOn: on, finishedOn: on, verifiedOn: null, beforePhotos: [], afterPhotos: [], parts: [], labourCost: 0, vendorCost: 0, blockId: null, expenses: [], history,
      upkeep: { key: plan.upkeep!.key, checklist, readingsRequired: plan.upkeep!.readings, readings: readings ? { ...readings, flags: poolFlags(readings.ph, readings.chlorine) } : null, window: null, outsideWindow: plan.upkeep!.outsideWindow, notice: null },
    })
    plan.lastDoneOn = plan.lastDoneOn && plan.lastDoneOn > on ? plan.lastDoneOn : on
  }
  const planOf = (villaId: string, key: string) => plans.find((p) => p.villaId === villaId && p.upkeep?.key === key)!
  done(planOf('vil-karang', 'pool_daily'), 2, { ph: 8.0, chlorine: 0.8 })
  done(planOf('vil-karang', 'pool_daily'), 1, { ph: 7.4, chlorine: 2 })
  done(planOf('vil-karang', 'garden_weekly'), 6, null)
  done(planOf('vil-tirta', 'pool_weekly'), 5, null)
  done(planOf('vil-tirta', 'pool_daily'), 1, { ph: 7.6, chlorine: 1.5 })

  return {
    unitItems,
    inventoryChecks,
    meters,
    meterReadings,
    utilitySettings,
    plans,
    workOrders,
    postings,
    next: { unitItem: itemSeq, inventoryCheck: inventoryChecks.length + 1, meter: meters.length + 1, meterReading: readingSeq, plan: planSeq, workOrder: woSeq, folio },
  }
}
