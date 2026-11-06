import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMISSIONS } from './access'
import { dayMarks, evaluateStay, markTags, mayOverrideRestrictions, restrictionOn, restrictionWhen, validateRestriction, type Restriction } from './restriction'

const rule = (fields: Partial<Restriction>): Restriction => ({ id: 'r', groupId: 'grp-a', unitId: null, rule: 'min_stay', nights: 3, yearly: true, from: '07-01', to: '08-31', weekdays: [], note: '', createdBy: 'Kadek', createdOn: '2026-01-01', ...fields })
const stay = (checkIn: string, checkOut: string, unitId: string | null = 'unit-a1') => ({ groupId: 'grp-a', unitId, checkIn, checkOut })
const rules = (list: Restriction[], checkIn: string, checkOut: string, unitId?: string | null) => evaluateStay(list, stay(checkIn, checkOut, unitId)).map((v) => v.rule)

describe('stay restrictions', () => {
  it('closes every night under a stop sell', () => {
    const closed = rule({ rule: 'stop_sell', nights: null, yearly: false, from: '2026-11-20', to: '2026-11-21' })
    const [v] = evaluateStay([closed], stay('2026-11-19', '2026-11-23'))
    expect(v?.dates).toEqual(['2026-11-20', '2026-11-21'])
    expect(v?.message).toBe('Closed for sale on Nov 20, Nov 21.')
    // Leaving on the first closed day sells: the night before is open.
    expect(evaluateStay([closed], stay('2026-11-18', '2026-11-20'))).toEqual([])
  })

  it('checks arrival on the check-in date and departure on the check-out date', () => {
    const cta = rule({ rule: 'closed_to_arrival', nights: null, yearly: false, from: '2026-11-21', to: '2026-11-21' })
    const ctd = rule({ rule: 'closed_to_departure', nights: null, yearly: false, from: '2026-11-21', to: '2026-11-21' })
    expect(rules([cta, ctd], '2026-11-21', '2026-11-23')).toEqual(['closed_to_arrival'])
    expect(rules([cta, ctd], '2026-11-19', '2026-11-21')).toEqual(['closed_to_departure'])
    // Staying through the date breaks neither.
    expect(rules([cta, ctd], '2026-11-20', '2026-11-22')).toEqual([])
  })

  it('reads minimum and maximum stay on the arrival date, the strictest winning', () => {
    const list = [rule({ nights: 3 }), rule({ id: 'r2', nights: 4, weekdays: [5] }), rule({ id: 'r3', rule: 'max_stay', nights: 10 })]
    // 2026-07-04 is a Saturday: four nights; a Friday arrival needs three.
    expect(evaluateStay(list, stay('2026-07-04', '2026-07-07'))[0]?.message).toBe('Arrivals on Jul 4 stay at least 4 nights; this stay has 3.')
    expect(rules(list, '2026-07-03', '2026-07-06')).toEqual([])
    expect(rules(list, '2026-07-03', '2026-07-15')).toEqual(['max_stay'])
    // Arriving the day before the range, the minimum stay does not apply.
    expect(rules(list, '2026-06-30', '2026-07-01')).toEqual([])
  })

  it('holds a minimum stay through on any night the stay covers', () => {
    const through = rule({ rule: 'min_stay_through', nights: 5, from: '12-28', to: '01-02' })
    expect(evaluateStay([through], stay('2026-12-26', '2026-12-29'))[0]).toMatchObject({ rule: 'min_stay_through', dates: ['2026-12-28'], nights: 5 })
    expect(rules([through], '2026-12-26', '2026-12-31')).toEqual([])
    expect(rules([through], '2026-12-20', '2026-12-28')).toEqual([])
  })

  it('comes back every year, over the new year too', () => {
    const season = rule({ from: '12-20', to: '01-05' })
    for (const date of ['2026-12-20', '2026-12-31', '2027-01-01', '2027-01-05', '2028-01-03']) expect(restrictionOn(season, date), date).toBe(true)
    for (const date of ['2026-12-19', '2027-01-06', '2027-07-01']) expect(restrictionOn(season, date), date).toBe(false)
    expect(rules([season], '2027-01-04', '2027-01-06')).toEqual(['min_stay'])
    expect(rules([season], '2027-01-06', '2027-01-07')).toEqual([])
  })

  it('keeps a unit rule on its unit and lists the rules in order', () => {
    const list = [rule({ rule: 'max_stay', nights: 1, yearly: false, from: '2026-11-20', to: '2026-11-30' }), rule({ id: 'u', unitId: 'unit-a2', rule: 'stop_sell', nights: null, yearly: false, from: '2026-11-20', to: '2026-11-30' }), rule({ id: 'x', groupId: 'grp-b', rule: 'closed_to_arrival', nights: null, yearly: false, from: '2026-11-20', to: '2026-11-20' })]
    expect(rules(list, '2026-11-20', '2026-11-22', 'unit-a2')).toEqual(['stop_sell', 'max_stay'])
    expect(rules(list, '2026-11-20', '2026-11-22', 'unit-a1')).toEqual(['max_stay'])
    // A stay booked against the type meets only the rules for the whole type.
    expect(rules(list, '2026-11-20', '2026-11-22', null)).toEqual(['max_stay'])
    expect(evaluateStay(list, { groupId: null, unitId: null, checkIn: '2026-11-20', checkOut: '2026-11-22' })).toEqual([])
  })

  it('marks a date for the picker and the calendar', () => {
    const list = [rule({ nights: 3 }), rule({ id: 'c', rule: 'closed_to_arrival', nights: null, weekdays: [5] }), rule({ id: 's', rule: 'stop_sell', nights: null, yearly: false, from: '2026-07-04', to: '2026-07-04' })]
    const sat = dayMarks(list, { groupId: 'grp-a', unitId: null }, '2026-07-04')
    expect(markTags(sat)).toEqual(['Closed', 'CTA', 'Min 3'])
    expect(markTags(dayMarks(list, { groupId: 'grp-a', unitId: null }, '2026-06-30'))).toEqual([])
    expect(restrictionWhen(list[1] as Restriction)).toBe('07-01 to 08-31 every year, Sat')
  })

  it('validates the rule, the nights, the range and the days', () => {
    expect(validateRestriction(rule({}))).toEqual({})
    expect(validateRestriction(rule({ nights: 0, from: '02-30', to: '13-01', weekdays: [7] }))).toEqual({ nights: 'Enter whole nights from 1 to 90.', from: 'Pick the first day as MM-DD.', to: 'Pick the last day as MM-DD.', weekdays: 'Pick each day of the week once.' })
    expect(validateRestriction(rule({ yearly: false, from: '2026-11-20', to: '2026-11-19' }))).toEqual({ to: 'The last day comes on or after the first.' })
    expect(validateRestriction(rule({ rule: 'stop_sell', nights: null }))).toEqual({})
  })

  it('lets a manager or whoever approves bookings override', () => {
    expect(mayOverrideRestrictions(DEFAULT_PERMISSIONS, 'manager')).toBe(true)
    expect(mayOverrideRestrictions(DEFAULT_PERMISSIONS, 'owner')).toBe(true)
    expect(mayOverrideRestrictions(DEFAULT_PERMISSIONS, 'reservation')).toBe(false)
    expect(mayOverrideRestrictions(DEFAULT_PERMISSIONS, 'staff')).toBe(false)
  })
})
