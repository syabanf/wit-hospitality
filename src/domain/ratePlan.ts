import { addDays, daysBetween, eachDay, weekdayIndex, type IsoDate } from '@/lib/dates'
import type { Listing } from './airbnb'
import type { Booking } from './booking'
import type { NightPrice } from './pricing'
import type { Unit } from './property'

/**
 * The fallback price list. A unit with a live Airbnb listing sells direct stays at the listing;
 * without one, its room type's rate plan prices the night: a weekday rate, a weekend rate for
 * Friday and Saturday nights, and seasons that come back every year.
 */

export type SeasonKind = 'fixed' | 'surcharge'
export const SEASON_KIND_LABEL: Record<SeasonKind, string> = { fixed: 'Fixed price', surcharge: 'Surcharge' }

export interface Season {
  name: string
  /** First and last night as MM-DD, both included; a season may run over the new year, 12-20 to 01-05. */
  from: string
  to: string
  kind: SeasonKind
  /** Whole rupiah a night for a fixed price, percent over the weekday or weekend rate for a surcharge. */
  value: number
}

export interface RatePlan {
  groupId: string
  weekdayRate: number
  /** Friday and Saturday nights. */
  weekendRate: number
  seasons: readonly Season[]
}
export type RatePlanInput = Omit<RatePlan, 'groupId'>

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
export const validMonthDay = (md: string) => {
  const [month = 0, day = 0] = /^\d{2}-\d{2}$/.test(md) ? md.split('-').map(Number) : []
  return day >= 1 && day <= (MONTH_DAYS[month - 1] ?? 0)
}

/** Nights a season covers in a year, counted on a leap year so 02-29 fits. */
const seasonLength = (s: Season) => {
  const span = daysBetween(`2024-${s.from}`, `2024-${s.to}`)
  return (span < 0 ? span + 366 : span) + 1
}

/** Whether a date falls in a yearly MM-DD range, both ends included; a range may run over the new year. */
export const inYearlyRange = (from: string, to: string, date: IsoDate) => {
  const md = date.slice(5)
  return from <= to ? md >= from && md <= to : md >= from || md <= to
}

export const inSeason = (s: Season, date: IsoDate) => inYearlyRange(s.from, s.to, date)

/** The season that prices a night when several cover it: the narrower one, and on equal length the one listed last. */
export function seasonOn(plan: Pick<RatePlan, 'seasons'>, date: IsoDate): Season | null {
  let found: Season | null = null
  for (const s of plan.seasons) if (inSeason(s, date) && (!found || seasonLength(s) <= seasonLength(found))) found = s
  return found
}

/** Friday and Saturday nights sell at the weekend rate. */
export const isWeekendNight = (date: IsoDate) => weekdayIndex(date) === 4 || weekdayIndex(date) === 5

/** What the plan charges for one night and the name of the rate that set it. */
export function planNight(plan: RatePlanInput, date: IsoDate): { rate: number; name: string } {
  const weekend = isWeekendNight(date)
  const base = weekend ? plan.weekendRate : plan.weekdayRate
  const season = seasonOn(plan, date)
  if (!season) return { rate: base, name: weekend ? 'Weekend' : 'Weekday' }
  return { rate: season.kind === 'fixed' ? season.value : Math.round((base * (100 + season.value)) / 100), name: season.name }
}

/** The list that prices a direct stay in a unit. */
export type PriceList = { kind: 'listing'; dateRates: Listing['dateRates'] } | { kind: 'plan'; plan: RatePlan }

/** The live Airbnb listing, else the rate plan of the unit's room type, else nothing to sell at. */
export function priceListFor(unit: Pick<Unit, 'groupId'>, listing: Pick<Listing, 'status' | 'dateRates'> | null | undefined, plans: readonly RatePlan[]): PriceList | null {
  if (listing?.status === 'active') return { kind: 'listing', dateRates: listing.dateRates }
  const plan = plans.find((p) => p.groupId === unit.groupId)
  return plan ? { kind: 'plan', plan } : null
}

export const PRICE_LIST_LABEL: Record<PriceList['kind'] | 'none', string> = { listing: 'Airbnb listing', plan: 'Rate plan', none: 'No price' }

/** The plan a new room type starts from: its base price on weekdays, about 20% more on weekends, rounded to Rp 10,000. */
export const defaultRatePlan = (baseRate: number): RatePlanInput => ({ weekdayRate: baseRate, weekendRate: Math.max(baseRate, Math.round((baseRate * 1.2) / 10_000) * 10_000), seasons: [] })

export const noPriceMessage = (unitCode: string) => `${unitCode} has no live Airbnb listing and its room type has no rate plan. Add a rate plan on the room type page.`

/** One night from the list: the listing's price for the date or the unit's base rate, or the plan's rate. */
export function listNight(list: PriceList, baseRate: number, date: IsoDate): NightPrice {
  if (list.kind === 'listing') return { date, rate: list.dateRates[date] ?? baseRate, source: { kind: 'listing' } }
  const night = planNight(list.plan, date)
  return { date, rate: night.rate, source: { kind: 'plan', name: night.name } }
}

export const listNights = (list: PriceList, baseRate: number, checkIn: IsoDate, checkOut: IsoDate) => eachDay(checkIn, checkOut).map((date) => listNight(list, baseRate, date))

/** The nights a stay was sold at, each with its source. Stays priced before sources were kept read as the listing or the channel. */
export const soldNights = (b: Pick<Booking, 'source' | 'checkIn' | 'listRates' | 'listSources'>): NightPrice[] =>
  b.listRates.map((rate, i) => ({ date: addDays(b.checkIn, i), rate, source: b.listSources?.[i] ?? (b.source === 'direct' ? { kind: 'listing' } : { kind: 'channel' }) }))

export function validateRatePlan(input: RatePlanInput): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!Number.isInteger(input.weekdayRate) || input.weekdayRate <= 0) errors.weekdayRate = 'Enter the weekday rate in whole rupiah.'
  if (!Number.isInteger(input.weekendRate) || input.weekendRate <= 0) errors.weekendRate = 'Enter the weekend rate in whole rupiah.'
  input.seasons.forEach((s, i) => {
    if (s.name.trim().length < 2) errors[`seasons.${i}.name`] = 'Name the season.'
    if (!validMonthDay(s.from)) errors[`seasons.${i}.from`] = 'Pick the first night.'
    if (!validMonthDay(s.to)) errors[`seasons.${i}.to`] = 'Pick the last night.'
    if (s.kind === 'fixed' && (!Number.isInteger(s.value) || s.value <= 0)) errors[`seasons.${i}.value`] = 'Enter the nightly price in whole rupiah.'
    if (s.kind === 'surcharge' && (!Number.isInteger(s.value) || s.value <= 0 || s.value > 300)) errors[`seasons.${i}.value`] = 'A whole percentage above 0, up to 300.'
  })
  return errors
}
