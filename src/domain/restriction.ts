import { addDays, daysBetween, eachDay, shortDay, weekdayIndex, type IsoDate } from '@/lib/dates'
import { can, type Permissions, type Role } from './access'
import { inYearlyRange, validMonthDay } from './ratePlan'

/**
 * Stay restrictions, as a channel manager sets them: per room type, or per unit of the type, over a
 * date range that comes back every year like a season or runs once. A new direct stay, a change of
 * dates and a group stay that break one are refused unless a manager overrides with a reason; a
 * channel stay is kept, since the channel already sold it, and carries a warning instead.
 */

export type RestrictionRule = 'stop_sell' | 'closed_to_arrival' | 'closed_to_departure' | 'min_stay' | 'min_stay_through' | 'max_stay'
/** Every rule, in the order a stay is checked against them and its violations are listed. */
export const RESTRICTION_RULES: readonly RestrictionRule[] = ['stop_sell', 'closed_to_arrival', 'closed_to_departure', 'min_stay', 'min_stay_through', 'max_stay']
export const RESTRICTION_RULE_LABEL: Record<RestrictionRule, string> = {
  stop_sell: 'Stop sell',
  closed_to_arrival: 'Closed to arrival',
  closed_to_departure: 'Closed to departure',
  min_stay: 'Minimum stay',
  min_stay_through: 'Minimum stay through',
  max_stay: 'Maximum stay',
}
export const RESTRICTION_RULE_HINT: Record<RestrictionRule, string> = {
  stop_sell: 'No night in the range can be sold.',
  closed_to_arrival: 'Guests cannot arrive on these dates.',
  closed_to_departure: 'Guests cannot leave on these dates.',
  min_stay: 'Arrivals on these dates stay at least this many nights.',
  min_stay_through: 'Any stay that covers one of these nights lasts at least this many nights.',
  max_stay: 'Arrivals on these dates stay at most this many nights.',
}
/** The rules that carry a number of nights. */
export const withNights = (rule: RestrictionRule) => rule === 'min_stay' || rule === 'min_stay_through' || rule === 'max_stay'

/** Monday first, as weekdayIndex counts. */
export const WEEKDAY_LABEL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export interface RestrictionInput {
  /** The room type the rule covers. */
  groupId: string
  /** One unit of the type, or null for every unit and for stays booked against the type. */
  unitId: string | null
  rule: RestrictionRule
  /** Nights for the minimum and maximum stay rules, null otherwise. */
  nights: number | null
  /** Yearly ranges are MM-DD and come back every year, over the new year too; one-off ranges are YYYY-MM-DD. Both ends included. */
  yearly: boolean
  from: string
  to: string
  /** Days of the week the rule holds on, by weekdayIndex (Monday 0); empty means every day. */
  weekdays: readonly number[]
  note: string
}

export interface Restriction extends RestrictionInput {
  id: string
  createdBy: string
  createdOn: IsoDate
}

/** The bulk editor: one rule over a range for several room types at once. */
export interface BulkRestrictionInput extends Omit<RestrictionInput, 'groupId' | 'unitId'> {
  groupIds: readonly string[]
}

export const MAX_RULE_NIGHTS = 90

export function validateRestriction(input: Omit<RestrictionInput, 'groupId' | 'unitId'>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!RESTRICTION_RULES.includes(input.rule)) errors.rule = 'Pick a rule.'
  if (withNights(input.rule) && (!Number.isInteger(input.nights) || (input.nights ?? 0) < 1 || (input.nights ?? 0) > MAX_RULE_NIGHTS)) errors.nights = `Enter whole nights from 1 to ${MAX_RULE_NIGHTS}.`
  if (input.yearly) {
    if (!validMonthDay(input.from)) errors.from = 'Pick the first day as MM-DD.'
    if (!validMonthDay(input.to)) errors.to = 'Pick the last day as MM-DD.'
  } else {
    const iso = /^\d{4}-\d{2}-\d{2}$/
    if (!iso.test(input.from)) errors.from = 'Pick the first day.'
    if (!iso.test(input.to)) errors.to = 'Pick the last day.'
    else if (iso.test(input.from) && input.to < input.from) errors.to = 'The last day comes on or after the first.'
  }
  if (input.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(input.weekdays).size !== input.weekdays.length) errors.weekdays = 'Pick each day of the week once.'
  return errors
}

/** Whether a restriction holds on one date: inside the range and on one of its days of the week. */
export function restrictionOn(r: Pick<Restriction, 'yearly' | 'from' | 'to' | 'weekdays'>, date: IsoDate): boolean {
  const inRange = r.yearly ? inYearlyRange(r.from, r.to, date) : date >= r.from && date <= r.to
  return inRange && (r.weekdays.length === 0 || r.weekdays.includes(weekdayIndex(date)))
}

/** The stay a rule is checked against. `unitId` is null for a stay booked against the room type. */
export interface StayShape {
  groupId: string | null
  unitId: string | null
  checkIn: IsoDate
  checkOut: IsoDate
}

export interface Violation {
  rule: RestrictionRule
  /** The dates that broke it, in stay order. */
  dates: IsoDate[]
  /** Nights the strictest rule asks for, for the stay rules. */
  nights: number | null
  message: string
}

/** Restrictions on the stay's room type: those for the whole type and those for its unit. */
const forStay = (list: readonly Restriction[], stay: Pick<StayShape, 'groupId' | 'unitId'>) => list.filter((r) => stay.groupId !== null && r.groupId === stay.groupId && (r.unitId === null || r.unitId === stay.unitId))

const days = (dates: readonly IsoDate[]) => dates.map(shortDay).join(', ')

/**
 * Every rule the stay breaks, one line per rule in RESTRICTION_RULES order. Stop sell and minimum
 * stay through look at each night; arrival, minimum and maximum stay at the check-in date;
 * departure at the check-out date. Where two rules of a kind apply, the strictest speaks.
 */
export function evaluateStay(list: readonly Restriction[], stay: StayShape): Violation[] {
  const mine = forStay(list, stay)
  if (mine.length === 0) return []
  const nights = Math.max(0, daysBetween(stay.checkIn, stay.checkOut))
  const stayNights = eachDay(stay.checkIn, stay.checkOut)
  const on = (rule: RestrictionRule, date: IsoDate) => mine.filter((r) => r.rule === rule && restrictionOn(r, date))
  const out: Violation[] = []
  for (const rule of RESTRICTION_RULES) {
    if (rule === 'stop_sell') {
      const closed = stayNights.filter((d) => on(rule, d).length > 0)
      if (closed.length) out.push({ rule, dates: closed, nights: null, message: `Closed for sale on ${days(closed)}.` })
    }
    if (rule === 'closed_to_arrival' && on(rule, stay.checkIn).length) out.push({ rule, dates: [stay.checkIn], nights: null, message: `No arrivals on ${shortDay(stay.checkIn)}.` })
    if (rule === 'closed_to_departure' && on(rule, stay.checkOut).length) out.push({ rule, dates: [stay.checkOut], nights: null, message: `No departures on ${shortDay(stay.checkOut)}.` })
    if (rule === 'min_stay') {
      const need = Math.max(0, ...on(rule, stay.checkIn).map((r) => r.nights ?? 0))
      if (nights < need) out.push({ rule, dates: [stay.checkIn], nights: need, message: `Arrivals on ${shortDay(stay.checkIn)} stay at least ${need} nights; this stay has ${nights}.` })
    }
    if (rule === 'min_stay_through') {
      const hits = stayNights.map((d) => ({ d, need: Math.max(0, ...on(rule, d).map((r) => r.nights ?? 0)) })).filter((x) => nights < x.need)
      const need = Math.max(0, ...hits.map((x) => x.need))
      if (hits.length) out.push({ rule, dates: hits.map((x) => x.d), nights: need, message: `Stays over ${days(hits.map((x) => x.d))} last at least ${need} nights; this stay has ${nights}.` })
    }
    if (rule === 'max_stay') {
      const caps = on(rule, stay.checkIn).map((r) => r.nights ?? MAX_RULE_NIGHTS)
      const cap = caps.length ? Math.min(...caps) : null
      if (cap !== null && nights > cap) out.push({ rule, dates: [stay.checkIn], nights: cap, message: `Arrivals on ${shortDay(stay.checkIn)} stay at most ${cap} nights; this stay has ${nights}.` })
    }
  }
  return out
}

/** One line for an error or an audit entry. */
export const violationSummary = (violations: readonly Violation[]) => violations.map((v) => v.message).join(' ')

/** What one date looks like to a guest picking it: sold or closed, open to arrival and departure, and the stay length an arrival needs. */
export interface DayMarks {
  date: IsoDate
  stopSell: boolean
  cta: boolean
  ctd: boolean
  /** Nights an arrival on this date needs, from minimum stay and minimum stay through. */
  minNights: number | null
  maxNights: number | null
}

export function dayMarks(list: readonly Restriction[], target: Pick<StayShape, 'groupId' | 'unitId'>, date: IsoDate): DayMarks {
  const on = forStay(list, target).filter((r) => restrictionOn(r, date))
  const nightsOf = (rule: RestrictionRule) => on.filter((r) => r.rule === rule).map((r) => r.nights ?? 0)
  const min = Math.max(0, ...nightsOf('min_stay'), ...nightsOf('min_stay_through'))
  const max = nightsOf('max_stay')
  return { date, stopSell: on.some((r) => r.rule === 'stop_sell'), cta: on.some((r) => r.rule === 'closed_to_arrival'), ctd: on.some((r) => r.rule === 'closed_to_departure'), minNights: min > 0 ? min : null, maxNights: max.length ? Math.min(...max) : null }
}

/** Marks for `count` dates from `from`, for the date picker and the calendar. */
export const marksFrom = (list: readonly Restriction[], target: Pick<StayShape, 'groupId' | 'unitId'>, from: IsoDate, count: number) => Array.from({ length: count }, (_, i) => dayMarks(list, target, addDays(from, i)))

/** Whether a mark has anything to say. */
export const marked = (m: DayMarks) => m.stopSell || m.cta || m.ctd || m.minNights !== null || m.maxNights !== null

/** Short tags for a date cell: Closed, CTA, CTD, Min 3. */
export function markTags(m: DayMarks): string[] {
  return [m.stopSell && 'Closed', m.cta && 'CTA', m.ctd && 'CTD', m.minNights !== null && `Min ${m.minNights}`, m.maxNights !== null && `Max ${m.maxNights}`].filter((t): t is string => Boolean(t))
}

/** How the range reads in a list: "07-01 to 08-31 every year, Sat". */
export function restrictionWhen(r: Pick<Restriction, 'yearly' | 'from' | 'to' | 'weekdays'>): string {
  const range = r.yearly ? `${r.from} to ${r.to} every year` : r.from === r.to ? r.from : `${r.from} to ${r.to}`
  return r.weekdays.length ? `${range}, ${[...r.weekdays].sort().map((d) => WEEKDAY_LABEL[d]).join(' ')}` : range
}

export const restrictionLabel = (r: Pick<Restriction, 'rule' | 'nights'>) => (withNights(r.rule) ? `${RESTRICTION_RULE_LABEL[r.rule]} ${r.nights} nights` : RESTRICTION_RULE_LABEL[r.rule])

/** Who may sell past a restriction: a person who may approve bookings, or a villa manager. */
export const mayOverrideRestrictions = (permissions: Permissions, role: Role) => role === 'manager' || can(permissions, role, 'booking', 'approve')

/** Asked with a booking or a change of dates to sell past the restrictions it breaks. */
export interface RestrictionOverrideInput {
  reason: string
}

/** On the booking: the rules a manager sold past, or the ones a channel stay came in against. */
export interface RestrictionNote {
  kind: 'override' | 'channel'
  rules: readonly RestrictionRule[]
  messages: readonly string[]
  /** The manager's reason; empty on a channel stay. */
  reason: string
  by: string
  on: IsoDate
}

/** The rules set on one unit alone. A stay booked by type met the type's rules at booking and meets these when it gets the room. */
export const unitRestrictions = (list: readonly Restriction[], unitId: string) => list.filter((r) => r.unitId === unitId)

/** A second note on a booking adds to the first: the rules and messages add up and the reasons join. */
export function mergeNotes(before: RestrictionNote | null | undefined, next: RestrictionNote): RestrictionNote {
  if (!before) return next
  return {
    ...next,
    kind: before.kind === 'override' || next.kind === 'override' ? 'override' : 'channel',
    rules: [...new Set([...before.rules, ...next.rules])],
    messages: [...before.messages, ...next.messages],
    reason: [before.reason, next.reason].filter(Boolean).join('; '),
  }
}
