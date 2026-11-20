import { daysBetween, type IsoDate } from '@/lib/dates'
import type { BookingStatus } from './booking'
import { RuleError } from './errors'

/**
 * Electricity, water and gas meters per villa or unit, their readings and what the usage bills to
 * the guest or the owner. Contract: api/docs/contracts/villa-operations-contract.md section 3.
 */

export type MeterKind = 'electricity' | 'water' | 'gas'
export const METER_KINDS: readonly MeterKind[] = ['electricity', 'water', 'gas']
export const METER_KIND_LABEL: Record<MeterKind, string> = { electricity: 'Electricity', water: 'Water', gas: 'Gas' }
export type MeterUnit = 'kWh' | 'm3'
export const METER_UNIT_OF: Record<MeterKind, MeterUnit> = { electricity: 'kWh', water: 'm3', gas: 'm3' }
export type MeterPayer = 'guest' | 'owner' | 'operator'
export const METER_PAYERS: readonly MeterPayer[] = ['guest', 'owner', 'operator']
export const METER_PAYER_LABEL: Record<MeterPayer, string> = { guest: 'Guest', owner: 'Owner', operator: 'Operator' }

export interface Meter {
  id: string
  villaId: string
  /** Null for a meter that serves the whole villa. */
  unitId: string | null
  kind: MeterKind
  number: string
  unit: MeterUnit
  /** Rupiah per kWh or m3. */
  tariff: number
  payer: MeterPayer
  active: boolean
}
export type MeterInput = Omit<Meter, 'id'>

export const DEFAULT_LONG_STAY_NIGHTS = 28

export interface UtilitySettings {
  villaId: string
  longStayNights: number
}

const whole = (n: number, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(n) && n >= min && n <= max

export function validateMeter(input: MeterInput, villa: { id: string; name: string }, villaMeters: readonly Meter[], unitVilla: (unitId: string) => string | undefined, current: Meter | null): Record<string, string> {
  const errors: Record<string, string> = {}
  if (current && input.villaId !== current.villaId) errors.villaId = 'A meter stays with its villa.'
  const number = input.number.trim()
  if (number.length < 2 || number.length > 30) errors.number = 'Enter the meter number.'
  else if (villaMeters.some((m) => m.id !== current?.id && m.number.toLowerCase() === number.toLowerCase())) errors.number = `${number} is already a meter of ${villa.name}.`
  if (!METER_KINDS.includes(input.kind)) errors.kind = 'Pick electricity, water or gas.'
  else if (METER_UNIT_OF[input.kind] !== input.unit) errors.unit = 'Electricity reads in kWh, water and gas in m3.'
  if (!whole(input.tariff, 0)) errors.tariff = 'Whole rupiah per unit, zero or more.'
  if (!METER_PAYERS.includes(input.payer)) errors.payer = 'Pick who pays.'
  if (input.unitId && unitVilla(input.unitId) !== villa.id) errors.unitId = 'Pick a unit of this villa.'
  return errors
}

export const validateLongStay = (nights: number): Record<string, string> => (whole(nights, 1, 365) ? {} : { longStayNights: 'A whole number of nights from 1 to 365.' })

export type ReadingPurpose = 'monthly' | 'check_in' | 'check_out'
export const READING_PURPOSES: readonly ReadingPurpose[] = ['monthly', 'check_in', 'check_out']
export const READING_PURPOSE_LABEL: Record<ReadingPurpose, string> = { monthly: 'Monthly', check_in: 'Check-in', check_out: 'Check-out' }

export interface MeterReading {
  id: string
  meterId: string
  villaId: string
  unitId: string | null
  on: IsoDate
  value: number
  photo: string | null
  purpose: ReadingPurpose
  bookingId: string | null
  bookingCode: string | null
  /** A new meter: it counts from this value and the reading consumes nothing. */
  replacement: boolean
  previous: number | null
  consumption: number
  /** What this reading billed, 0 when nothing. */
  amount: number
  billedTo: 'guest' | 'owner' | null
  by: string
  byId: string
}

export interface ReadingInput {
  meterId: string
  on: IsoDate
  value: number
  photo: string | null
  purpose: ReadingPurpose
  bookingId: string | null
  replacement: boolean
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
/** The sequence number in an id such as mrd-12. */
const seqOf = (id: string) => Number(id.replace(/\D/g, '')) || 0
export const round2 = (n: number) => Math.round(n * 100) / 100
const twoDecimals = (n: number) => Number.isFinite(n) && Math.abs(round2(n) - n) < 1e-9

/** A stay as the reading rules see it. */
export interface ReadingStay {
  id: string
  code: string
  unitId: string
  status: BookingStatus
  checkIn: IsoDate
  checkOut: IsoDate
}

export interface ReadingContext {
  meter: Meter
  /** The meter's readings, any order. */
  readings: readonly MeterReading[]
  today: IsoDate
  stay: ReadingStay | null
  longStayNights: number
  /** Units the meter serves: its own, or every unit of its villa. */
  serves: (unitId: string) => boolean
}

/** The meter's last reading, the latest date then the latest recorded. */
/** Readings go in date order, so the last recorded is the latest. */
export const lastReading = (readings: readonly MeterReading[]) => readings.reduce<MeterReading | null>((last, r) => (!last || seqOf(r.id) > seqOf(last.id) ? r : last), null)

const purposeWord = (p: ReadingPurpose) => (p === 'check_in' ? 'check-in' : 'check-out')

/**
 * The reading rules in the API's order. Field errors come back; rules throw. Returns the previous
 * value and the consumption the reading records.
 */
export function validateReading(input: ReadingInput, ctx: ReadingContext): { errors: Record<string, string>; previous: number | null; consumption: number } {
  const errors: Record<string, string> = {}
  if (!DATE.test(input.on)) errors.on = 'Pick the reading date.'
  else if (input.on > ctx.today) errors.on = 'A reading cannot be dated after today.'
  if (typeof input.value !== 'number' || input.value < 0 || !twoDecimals(input.value)) errors.value = 'Enter the meter value.'
  if (!READING_PURPOSES.includes(input.purpose)) errors.purpose = 'Pick monthly, check-in or check-out.'
  if (Object.keys(errors).length) return { errors, previous: null, consumption: 0 }
  const { meter } = ctx
  if (!meter.active) throw new RuleError('METER_INACTIVE', `${meter.number} is out of use.`)
  const last = lastReading(ctx.readings)
  if (last && input.on < last.on) throw new RuleError('READING_OUT_OF_ORDER', `${meter.number} was last read on ${last.on}; record readings in date order.`)
  if (last && input.value < last.value && !input.replacement) throw new RuleError('READING_BELOW_PREVIOUS', `${input.value} is below the last reading of ${last.value} on ${last.on}; mark it a meter replacement if the meter was changed.`)
  if (input.purpose !== 'monthly') {
    if (!input.bookingId) return { errors: { bookingId: 'Pick the stay this reading belongs to.' }, previous: null, consumption: 0 }
    const stay = ctx.stay
    if (!stay || !ctx.serves(stay.unitId)) return { errors: { bookingId: "Pick a stay of this meter's unit." }, previous: null, consumption: 0 }
    const nights = daysBetween(stay.checkIn, stay.checkOut)
    if (nights < ctx.longStayNights) throw new RuleError('READING_SHORT_STAY', `${stay.code} is ${nights} nights; check-in and check-out readings are for stays of ${ctx.longStayNights} nights or more.`)
    if (ctx.readings.some((r) => r.bookingId === stay.id && r.purpose === input.purpose)) throw new RuleError('READING_TWICE', `${stay.code} already has a ${purposeWord(input.purpose)} reading on ${meter.number}.`)
    if (input.purpose === 'check_out') {
      if (!ctx.readings.some((r) => r.bookingId === stay.id && r.purpose === 'check_in')) throw new RuleError('READING_NO_CHECK_IN', `Record the check-in reading of ${stay.code} on ${meter.number} first.`)
      if (meter.payer === 'guest' && stay.status !== 'checked_in') throw new RuleError('READING_STAY_CLOSED', `${stay.code} has checked out; take the check-out reading while the guest is in house.`)
    }
  }
  const previous = last ? last.value : null
  return { errors, previous, consumption: input.replacement || previous === null ? 0 : round2(input.value - previous) }
}

export interface UtilityBill {
  payer: 'guest' | 'owner'
  usage: number
  amount: number
}

/**
 * What a new reading bills, once per reading pair: a guest-paid meter's check-out bills the usage
 * since the stay's check-in reading, an owner-paid meter's monthly reading its consumption.
 * `earlier` are the meter's readings before this one.
 */
export function readingBill(meter: Pick<Meter, 'payer' | 'tariff'>, reading: Pick<MeterReading, 'purpose' | 'bookingId' | 'consumption'>, earlier: readonly MeterReading[]): UtilityBill | null {
  let usage: number | null = null
  if (meter.payer === 'guest' && reading.purpose === 'check_out') {
    const start = earlier.find((r) => r.bookingId === reading.bookingId && r.purpose === 'check_in')
    if (!start) return null
    const after = earlier.filter((r) => seqOf(r.id) > seqOf(start.id))
    usage = round2(after.reduce((s, r) => s + r.consumption, 0) + reading.consumption)
  } else if (meter.payer === 'owner' && reading.purpose === 'monthly') usage = reading.consumption
  if (usage === null) return null
  const amount = Math.round(usage * meter.tariff)
  return amount > 0 ? { payer: meter.payer === 'guest' ? 'guest' : 'owner', usage, amount } : null
}


export const utilityDescription = (meter: Pick<Meter, 'kind' | 'unit' | 'tariff' | 'number'>, usage: number) => `${METER_KIND_LABEL[meter.kind]} ${usage} ${meter.unit} at ${meter.tariff} per ${meter.unit}, meter ${meter.number}`

/** One owner-paid month of a meter on an owner statement. */
export interface StatementUtility {
  readingId: string
  on: IsoDate
  meterNumber: string
  kind: MeterKind
  usage: number
  unit: MeterUnit
  tariff: number
  amount: number
}

/** The owner-paid lines of a villa's month, from the readings and their meters. */
export function ownerUtilities(readings: readonly MeterReading[], meters: readonly Meter[], villaId: string, month: string): StatementUtility[] {
  return readings
    .filter((r) => r.villaId === villaId && r.billedTo === 'owner' && r.on.slice(0, 7) === month)
    .flatMap((r) => {
      const m = meters.find((x) => x.id === r.meterId)
      return m ? [{ readingId: r.id, on: r.on, meterNumber: m.number, kind: m.kind, usage: r.consumption, unit: m.unit, tariff: m.tariff, amount: r.amount }] : []
    })
    .sort((a, b) => a.on.localeCompare(b.on) || a.readingId.localeCompare(b.readingId))
}

/** Consumption per month (YYYY-MM) of the readings given. */
export function consumptionByMonth(readings: readonly Pick<MeterReading, 'on' | 'consumption'>[], months: readonly string[]): number[] {
  return months.map((m) => round2(readings.filter((r) => r.on.slice(0, 7) === m).reduce((s, r) => s + r.consumption, 0)))
}
