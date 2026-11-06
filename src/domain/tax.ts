import { addDays, type IsoDate } from '@/lib/dates'
import type { Booking, BookingSource } from './booking'
import { nightCharges } from './pricing'
import { ROOM_CODE } from './transactionCode'

/**
 * Indonesian hotel tax and service charge. A Bali hotel bills a service charge on the room and F&B
 * and PB1 (Pajak Hotel, the regional tax) on top, commonly on the amount plus service: the "++"
 * convention. Finance sets the rates, which codes carry each, and how direct prices read; a new rate
 * applies from its effective date, so earlier postings never change.
 */

export type PriceMode = 'net' | 'inclusive'
export const PRICE_MODE_LABEL: Record<PriceMode, string> = { net: 'Net, service and PB1 added on the bill', inclusive: 'Inclusive, service and PB1 inside the price' }

/** The codes the folio and the journal put service and PB1 on. */
export const SERVICE_CODE = 'SVC'
export const PB1_CODE = 'PB1'

export interface TaxRates {
  /** The first posting date the rates apply to. */
  effectiveFrom: IsoDate
  servicePct: number
  pb1Pct: number
  /** PB1 on the amount plus service ("++"); off, PB1 on the amount alone. */
  pb1OnService: boolean
  /** Charge codes that carry service; the rest carry none. */
  serviceCodes: readonly string[]
  /** Charge codes that carry PB1. */
  pb1Codes: readonly string[]
}

export interface TaxSettings {
  /** Oldest first; each applies to postings dated on or after its date until the next one starts. */
  rates: readonly TaxRates[]
  /** How direct prices and rate plans read. Airbnb prices are always inclusive: Airbnb collects, the operator remits. */
  directMode: PriceMode
  /** The regency each location pays PB1 to, by location id; a location left out pays where its area names. */
  regencies: Readonly<Record<string, string>>
}

/**
 * Room and late check-out, F&B, minibar, spa and extras carry both. Laundry carries PB1 only: a
 * hotel service with no service charge. Transfers and tours are partner services resold at cost
 * plus margin and damage is a reimbursement, so TRNS, TOUR and DMG carry neither.
 */
export const DEFAULT_SERVICE_CODES: readonly string[] = ['ROOM', 'LATE', 'FNB', 'MINI', 'SPA', 'XTRA']
export const DEFAULT_PB1_CODES: readonly string[] = [...DEFAULT_SERVICE_CODES, 'LDRY']
export const DEFAULT_TAX_RATES: TaxRates = { effectiveFrom: '2020-01-01', servicePct: 10, pb1Pct: 10, pb1OnService: true, serviceCodes: DEFAULT_SERVICE_CODES, pb1Codes: DEFAULT_PB1_CODES }
export const DEFAULT_TAX_SETTINGS: TaxSettings = { rates: [DEFAULT_TAX_RATES], directMode: 'net', regencies: {} }

/** Whole rupiah, half away from zero. */
export const roundHalfUp = (v: number) => Math.sign(v) * Math.floor(Math.abs(v) + 0.5)

/** The rates a posting dated `date` uses; null before the first rates start, so nothing is taxed. */
export function ratesOn(t: Pick<TaxSettings, 'rates'> | undefined, date: IsoDate): TaxRates | null {
  let found: TaxRates | null = null
  for (const r of t?.rates ?? []) if (r.effectiveFrom <= date && (!found || r.effectiveFrom >= found.effectiveFrom)) found = r
  return found
}

/** One charge line as its net amount, service and PB1. */
export interface TaxSplit {
  net: number
  service: number
  pb1: number
}
export const grossOf = (s: TaxSplit) => s.net + s.service + s.pb1
export const sumSplits = (list: readonly TaxSplit[]): TaxSplit => list.reduce((a, s) => ({ net: a.net + s.net, service: a.service + s.service, pb1: a.pb1 + s.pb1 }), { net: 0, service: 0, pb1: 0 })
export const minusSplit = (a: TaxSplit, b: TaxSplit): TaxSplit => ({ net: a.net - b.net, service: a.service - b.service, pb1: a.pb1 - b.pb1 })

/**
 * The service and PB1 lines for one charge on `code`. A net price adds them on top; an inclusive
 * price is the gross, and the net comes out of it with the rounding left on PB1 (on service when
 * the code carries no PB1), so the three always add back to the price.
 */
export function taxSplit(amount: number, code: string, rates: TaxRates | null, mode: PriceMode): TaxSplit {
  const service = rates?.serviceCodes.includes(code) ? rates.servicePct : 0
  const pb1 = rates?.pb1Codes.includes(code) ? rates.pb1Pct : 0
  if (!rates || (service === 0 && pb1 === 0)) return { net: amount, service: 0, pb1: 0 }
  if (mode === 'net') {
    const s = roundHalfUp((amount * service) / 100)
    return { net: amount, service: s, pb1: roundHalfUp(((amount + (rates.pb1OnService ? s : 0)) * pb1) / 100) }
  }
  const factor = 1 + service / 100 + (pb1 / 100) * (rates.pb1OnService ? 1 + service / 100 : 1)
  const net = roundHalfUp(amount / factor)
  const s = pb1 > 0 ? roundHalfUp((net * service) / 100) : amount - net
  return { net, service: s, pb1: amount - net - s }
}

/**
 * What a rebate of `amount` takes back off a line of `line.net` that carries `line.service` and
 * `line.pb1`, after `rebated` already came off it: the line's tax in proportion, counted on the
 * running total so a rebate of the whole line returns its tax to the rupiah.
 */
export function rebateSplit(line: TaxSplit, rebated: number, amount: number): TaxSplit {
  const share = (tax: number, part: number) => (line.net > 0 ? roundHalfUp((tax * part) / line.net) : 0)
  const cut = (tax: number) => share(tax, rebated + amount) - share(tax, rebated)
  return { net: amount, service: cut(line.service), pb1: cut(line.pb1) }
}

/** The mode a new stay sells in. */
export const modeFor = (source: BookingSource, t: Pick<TaxSettings, 'directMode'>): PriceMode => (source === 'direct' ? t.directMode : 'inclusive')
/** Stays priced before the console have no mode: what was paid is the bill, so they read inclusive. */
export const stayMode = (b: Pick<Booking, 'priceMode'>): PriceMode => b.priceMode ?? 'inclusive'

/** The date each night posts on: its night audit, check-out for nights no audit reached, else the night itself while it is a forecast. */
export function nightDates(b: Pick<Booking, 'checkIn' | 'status' | 'checkedOutOn' | 'nightsPosted' | 'listRates'>): IsoDate[] {
  const audited = b.nightsPosted ?? []
  return b.listRates.map((_, i) => audited[i] ?? (b.status === 'checked_out' && b.checkedOutOn ? b.checkedOutOn : addDays(b.checkIn, i)))
}

type TaxedStay = Parameters<typeof nightCharges>[0] & Parameters<typeof nightDates>[0] & Pick<Booking, 'priceMode'>

/** Each night on the ROOM code at the rates of the day it posts. */
export function nightSplits(b: TaxedStay, t: Pick<TaxSettings, 'rates'> | undefined): TaxSplit[] {
  const dates = nightDates(b)
  return nightCharges(b).map((amount, i) => taxSplit(amount, ROOM_CODE, ratesOn(t, dates[i] ?? b.checkIn), stayMode(b)))
}

/** A stay's room with its tax: net, service, PB1, what the guest pays and the rates the note quotes. */
export interface StayTax extends TaxSplit {
  mode: PriceMode
  total: number
  servicePct: number
  pb1Pct: number
}

export function stayTax(b: TaxedStay, t: Pick<TaxSettings, 'rates'> | undefined): StayTax {
  const s = sumSplits(nightSplits(b, t))
  const rates = ratesOn(t, b.checkIn)
  return { ...s, mode: stayMode(b), total: grossOf(s), servicePct: rates?.servicePct ?? 0, pb1Pct: rates?.pb1Pct ?? 0 }
}

/** The line a quote, checkout page or invoice prints under the price. */
export const taxNote = (t: Pick<StayTax, 'mode' | 'servicePct' | 'pb1Pct'>) =>
  t.servicePct === 0 && t.pb1Pct === 0 ? '' : `Prices ${t.mode === 'net' ? 'exclude' : 'include'} ${t.servicePct}% service and ${t.pb1Pct}% PB1`

export type TaxSettingsInput = { rates: TaxRates; directMode: PriceMode; regencies: Record<string, string> }

export function validateTaxSettings(input: TaxSettingsInput, codes: readonly string[]): Partial<Record<'effectiveFrom' | 'servicePct' | 'pb1Pct' | 'codes' | 'regencies', string>> {
  const errors: Partial<Record<'effectiveFrom' | 'servicePct' | 'pb1Pct' | 'codes' | 'regencies', string>> = {}
  const r = input.rates
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.effectiveFrom)) errors.effectiveFrom = 'Pick the date the rates start.'
  if (!(r.servicePct >= 0 && r.servicePct <= 25)) errors.servicePct = 'A percentage from 0 to 25.'
  if (!(r.pb1Pct >= 0 && r.pb1Pct <= 25)) errors.pb1Pct = 'A percentage from 0 to 25.'
  if ([...r.serviceCodes, ...r.pb1Codes].some((c) => !codes.includes(c))) errors.codes = 'Pick charge codes from the list.'
  if (Object.values(input.regencies).some((v) => v.trim().length < 3)) errors.regencies = 'Name the regency of every location.'
  return errors
}

/** Whether two rate sets charge the same, whatever their dates. */
export const sameRates = (a: TaxRates, b: TaxRates) => {
  const codes = (list: readonly string[]) => [...list].sort().join()
  return a.servicePct === b.servicePct && a.pb1Pct === b.pb1Pct && a.pb1OnService === b.pb1OnService && codes(a.serviceCodes) === codes(b.serviceCodes) && codes(a.pb1Codes) === codes(b.pb1Codes)
}

/** Rates for `effectiveFrom` replace any that start the same day; earlier ones stay as they were. */
export const withRates = (t: TaxSettings, rates: TaxRates): TaxRates[] => [...t.rates.filter((r) => r.effectiveFrom !== rates.effectiveFrom), rates].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))

/** The regency a location pays PB1 to: the one set, else the first part of its area ("Badung, Bali"). */
export const regencyOf = (t: Pick<TaxSettings, 'regencies'>, location: { id: string; area?: string; name: string }) => t.regencies[location.id] ?? location.area?.split(',')[0]?.trim() ?? location.name
