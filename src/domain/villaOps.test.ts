import { describe, expect, it } from 'vitest'
import { RuleError } from './errors'
import { checkDiffs, itemsToCopy, validateCharge, validateCheck, validateUnitItem, type CheckLine, type UnitItem } from './unitInventory'
import { assertReadingsBeforeDone, poolFlags, recordUpkeep, templatePlans, upkeepTask, validateApplyTemplate, validateUpkeep, type WorkOrderUpkeep } from './upkeep'
import { ownerUtilities, readingBill, validateMeter, validateReading, type Meter, type MeterReading } from './utilities'

const item = (id: string, name: string, expected = 2, replacementCost = 100_000): UnitItem => ({ id, unitId: 'u-1', villaId: 'v-1', name, category: 'kitchen', expected, condition: '', photo: null, replacementCost })
const code = (run: () => unknown) => {
  try {
    run()
    return 'ok'
  } catch (e) {
    return e instanceof RuleError ? e.code : String(e)
  }
}

describe('unit inventory', () => {
  const list = [item('i-1', 'Wine glass', 8), item('i-2', 'Kettle', 1, 0)]

  it('names each item once per unit and keeps it on its unit', () => {
    expect(validateUnitItem({ unitId: 'u-1', name: 'wine glass', category: 'kitchen', expected: 2, condition: '', photo: null, replacementCost: 0 }, list, null).name).toBe('wine glass is already on this list.')
    expect(validateUnitItem({ unitId: 'u-2', name: 'Wine glass', category: 'kitchen', expected: 0, condition: '', photo: null, replacementCost: -1 }, list, list[0]!)).toEqual({ unitId: 'An item stays with its unit.', expected: 'A whole number from 1 to 999.', replacementCost: 'Whole rupiah, zero or more.' })
  })

  it('copies the items the target lacks and refuses an empty copy', () => {
    expect(itemsToCopy(list, [item('i-9', 'Kettle')], { source: 'KR-01', target: 'KR-02' }, false).map((i) => i.name)).toEqual(['Wine glass'])
    expect(code(() => itemsToCopy(list, list, { source: 'KR-01', target: 'KR-02' }, false))).toBe('INVENTORY_COPY_NOTHING')
    expect(code(() => itemsToCopy([], [], { source: 'KR-01', target: 'KR-02' }, false))).toBe('INVENTORY_COPY_EMPTY')
    expect(code(() => itemsToCopy(list, [], { source: 'KR-01', target: 'KR-01' }, true))).toBe('INVENTORY_COPY_SELF')
  })

  it('checks the stay, a second check and every line', () => {
    const stay = { id: 'b-1', unitId: 'u-1', code: 'BK-1', status: 'checked_out' as const }
    const lines = [
      { itemId: 'i-1', counted: 7, condition: 'ok' as const, note: '' },
      { itemId: 'i-2', counted: 1, condition: 'ok' as const, note: '' },
    ]
    expect(code(() => validateCheck({ unitId: 'u-1', bookingId: 'b-1', kind: 'pre_arrival', lines }, list, 'KR-01', stay, []))).toBe('CHECK_STAY_STATE')
    expect(code(() => validateCheck({ unitId: 'u-1', bookingId: 'b-1', kind: 'post_departure', lines }, list, 'KR-01', stay, [{ bookingId: 'b-1', kind: 'post_departure' }]))).toBe('CHECK_TWICE')
    expect(code(() => validateCheck({ unitId: 'u-1', bookingId: 'b-1', kind: 'post_departure', lines }, [], 'KR-01', stay, []))).toBe('CHECK_NO_LIST')
    expect(validateCheck({ unitId: 'u-1', bookingId: 'b-1', kind: 'post_departure', lines }, list, 'KR-01', stay, [])).toEqual({ 'lines.0.condition': '7 of 8 found; mark it missing or damaged.' })
    expect(validateCheck({ unitId: 'u-1', bookingId: 'b-1', kind: 'post_departure', lines: lines.slice(1) }, list, 'KR-01', stay, [])).toEqual({ lines: 'Count every item on the list.' })
  })

  it('highlights lines off the list and off the pre-arrival count', () => {
    const line = (counted: number, condition: CheckLine['condition']): CheckLine => ({ itemId: 'i-1', name: 'Wine glass', category: 'kitchen', expected: 8, counted, condition, note: '', replacementCost: 120_000, charge: null, workOrder: null, adjusted: false })
    const [diff] = checkDiffs({ kind: 'post_departure', lines: [line(7, 'missing')] }, { lines: [line(8, 'ok')] })
    expect(diff).toMatchObject({ vsList: -1, vsPre: -1, conditionChanged: true, flagged: true })
    expect(checkDiffs({ kind: 'post_departure', lines: [line(8, 'ok')] }, null)[0]?.flagged).toBe(false)
  })

  it('charges a damaged item once, after departure, while the guest is in house', () => {
    const line: CheckLine = { itemId: 'i-1', name: 'Wine glass', category: 'kitchen', expected: 8, counted: 8, condition: 'damaged', note: '', replacementCost: 120_000, charge: null, workOrder: null, adjusted: false }
    const post = { kind: 'post_departure' as const, bookingCode: 'BK-1' }
    expect(code(() => validateCharge({ ...post, kind: 'pre_arrival' }, line, { quantity: 1, reason: 'Broken' }, true))).toBe('CHECK_KIND')
    expect(code(() => validateCharge(post, { ...line, condition: 'ok' }, { quantity: 1, reason: 'Broken' }, true))).toBe('CHECK_LINE_OK')
    expect(code(() => validateCharge(post, { ...line, charge: { sourceRef: 'x', quantity: 1, amount: 1, reason: 'x', by: 'x', on: '2026-11-11' } }, { quantity: 1, reason: 'Broken' }, true))).toBe('CHECK_CHARGED')
    expect(code(() => validateCharge(post, { ...line, replacementCost: 0 }, { quantity: 1, reason: 'Broken' }, true))).toBe('CHECK_NO_COST')
    expect(validateCharge(post, line, { quantity: 9, reason: 'x' }, true)).toEqual({ quantity: 'From 1 to 8.', reason: 'Say why the guest pays for it.' })
    expect(code(() => validateCharge(post, line, { quantity: 1, reason: 'Broken' }, false))).toBe('CHECK_STAY_CLOSED')
  })
})

describe('meters and readings', () => {
  const meter: Meter = { id: 'mtr-1', villaId: 'v-1', unitId: 'u-1', kind: 'electricity', number: 'PLN-1', unit: 'kWh', tariff: 1_700, payer: 'guest', active: true }
  const reading = (id: string, on: string, value: number, extra: Partial<MeterReading> = {}): MeterReading => ({ id, meterId: 'mtr-1', villaId: 'v-1', unitId: 'u-1', on, value, photo: null, purpose: 'monthly', bookingId: null, bookingCode: null, replacement: false, previous: null, consumption: 0, amount: 0, billedTo: null, by: 'x', byId: 'x', ...extra })
  const stay = { id: 'b-1', code: 'BK-1', unitId: 'u-1', status: 'checked_in' as const, checkIn: '2026-10-01', checkOut: '2026-11-11' }
  const ctx = (readings: MeterReading[], extra = {}) => ({ meter, readings, today: '2026-11-11', stay, longStayNights: 28, serves: (u: string) => u === 'u-1', ...extra })
  const input = { meterId: 'mtr-1', on: '2026-11-11', value: 100, photo: null, purpose: 'monthly' as const, bookingId: null, replacement: false }

  it('matches the unit to the kind and names each meter once per villa', () => {
    expect(validateMeter({ ...meter, unit: 'm3', number: 'pln-1' }, { id: 'v-1', name: 'Karang' }, [meter], () => 'v-1', null)).toEqual({ number: 'pln-1 is already a meter of Karang.', unit: 'Electricity reads in kWh, water and gas in m3.' })
  })

  it('refuses a reading below the last one unless the meter was replaced', () => {
    const last = reading('mrd-1', '2026-11-01', 120)
    expect(code(() => validateReading(input, ctx([last])))).toBe('READING_BELOW_PREVIOUS')
    expect(validateReading({ ...input, replacement: true }, ctx([last]))).toMatchObject({ previous: 120, consumption: 0 })
    expect(validateReading({ ...input, value: 130.25 }, ctx([last]))).toMatchObject({ consumption: 10.25 })
    expect(code(() => validateReading({ ...input, on: '2026-10-30' }, ctx([last])))).toBe('READING_OUT_OF_ORDER')
  })

  it('keeps check-in and check-out readings to long stays, in order', () => {
    const stayInput = { ...input, purpose: 'check_out' as const, bookingId: 'b-1' }
    expect(code(() => validateReading(stayInput, ctx([])))).toBe('READING_NO_CHECK_IN')
    expect(code(() => validateReading({ ...stayInput, purpose: 'check_in' }, ctx([], { longStayNights: 60 })))).toBe('READING_SHORT_STAY')
    const checkIn = reading('mrd-1', '2026-10-01', 50, { purpose: 'check_in', bookingId: 'b-1' })
    expect(code(() => validateReading({ ...stayInput, purpose: 'check_in' }, ctx([checkIn])))).toBe('READING_TWICE')
    expect(code(() => validateReading(stayInput, ctx([checkIn], { stay: { ...stay, status: 'checked_out' } })))).toBe('READING_STAY_CLOSED')
  })

  it('bills the guest the stay usage once and the owner the month', () => {
    const checkIn = reading('mrd-1', '2026-10-01', 50, { purpose: 'check_in', bookingId: 'b-1' })
    const monthly = reading('mrd-2', '2026-11-01', 80, { consumption: 30 })
    expect(readingBill(meter, { purpose: 'check_out', bookingId: 'b-1', consumption: 20.5 }, [checkIn, monthly])).toEqual({ payer: 'guest', usage: 50.5, amount: 85_850 })
    expect(readingBill(meter, { purpose: 'monthly', bookingId: null, consumption: 20 }, [])).toBeNull()
    expect(readingBill({ ...meter, payer: 'owner' }, { purpose: 'monthly', bookingId: null, consumption: 20 }, [])).toEqual({ payer: 'owner', usage: 20, amount: 34_000 })
    const lines = ownerUtilities([reading('mrd-3', '2026-11-01', 80, { consumption: 20, amount: 34_000, billedTo: 'owner' })], [{ ...meter, payer: 'owner' }], 'v-1', '2026-11')
    expect(lines).toEqual([{ readingId: 'mrd-3', on: '2026-11-01', meterNumber: 'PLN-1', kind: 'electricity', usage: 20, unit: 'kWh', tariff: 1_700, amount: 34_000 }])
  })
})

describe('upkeep templates', () => {
  it('gives a villa the template plans once', () => {
    const plans = templatePlans({ villaId: 'v-1', unitId: null, template: 'pool', startOn: '2026-11-11' }).map((p, i) => ({ ...p, id: `p-${i}` }))
    expect(plans.map((p) => p.upkeep?.key)).toEqual(['pool_daily', 'pool_weekly', 'pool_monthly'])
    expect(code(() => validateApplyTemplate({ villaId: 'v-1', unitId: null, template: 'pool', startOn: '2026-11-11' }, 'Karang', () => 'v-1', plans))).toBe('UPKEEP_APPLIED')
    expect(validateApplyTemplate({ villaId: 'v-1', unitId: 'u-9', template: 'pond' as never, startOn: '' }, 'Karang', () => 'v-2', plans)).toEqual({ template: 'Pick pool, garden or fogging.', startOn: 'Pick the first day.', unitId: 'Pick a unit of this villa.' })
  })

  it('skips a do-not-disturb stay and keeps fogging outside the window with a notice', () => {
    const [fog] = templatePlans({ villaId: 'v-1', unitId: null, template: 'fogging', startOn: '2026-11-11' })
    const plan = { ...fog!, upkeep: fog!.upkeep! }
    expect(upkeepTask(plan, { bookingId: 'b-1', bookingCode: 'BK-1', window: { mode: 'dnd', from: '', to: '' } }, 'Villa Karang', '2026-11-11')).toBeNull()
    const task = upkeepTask(plan, { bookingId: 'b-1', bookingCode: 'BK-1', window: { mode: 'window', from: '10:00', to: '12:00' } }, 'Villa Karang', '2026-11-11')
    expect(task?.note).toBe("Outside the guest's service window 10:00 to 12:00.")
    expect(task?.upkeep.notice?.text).toContain('outside your service window (10:00 to 12:00)')
    expect(upkeepTask(plan, null, 'Villa Karang', '2026-11-11')?.upkeep.notice).toBeNull()
  })

  it('flags pool chemistry out of range and needs it before closing', () => {
    expect(poolFlags(8, 0.8)).toEqual(['pH high', 'Chlorine low'])
    expect(poolFlags(7.4, 2)).toEqual([])
    const upkeep: WorkOrderUpkeep = { key: 'pool_daily', checklist: [{ item: 'Skim', done: false }], readingsRequired: true, readings: null, window: null, outsideWindow: false, notice: null }
    const w = { number: 'WO-1', status: 'in_progress' as const, upkeep }
    expect(code(() => assertReadingsBeforeDone(w, 'done'))).toBe('READINGS_REQUIRED')
    expect(validateUpkeep(w, { checklist: [], readings: { ph: 15, chlorine: 2 }, noticeSent: false })).toEqual({ checklist: 'Tick the checklist as listed.', ph: 'pH from 0 to 14.' })
    const after = recordUpkeep(upkeep, { checklist: [true], readings: { ph: 7.9, chlorine: 2 }, noticeSent: false }, '2026-11-11')
    expect(after.readings?.flags).toEqual(['pH high'])
    expect(code(() => assertReadingsBeforeDone({ ...w, upkeep: after }, 'done'))).toBe('ok')
    expect(code(() => validateUpkeep({ ...w, status: 'verified' }, { checklist: [true], readings: null, noticeSent: false }))).toBe('WORK_ORDER_INVALID_STATE')
  })
})
