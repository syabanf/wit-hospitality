import { addDays, daysBetween, type IsoDate } from '@/lib/dates'

/**
 * Room prices. The Airbnb listing is the one price list: its base rate sits on the unit and its
 * per-date prices on the listing. A direct stay starts from that list and may carry a staff
 * override or a discount; an Airbnb stay keeps the price the channel sold it for.
 */

/** Prices a listing carries on given nights, over the unit's base rate. */
export type DateRates = Readonly<Record<IsoDate, number>>

export type DiscountKind = 'percent' | 'amount'
export type DiscountPer = 'night' | 'stay'
export const DISCOUNT_PER_LABEL: Record<DiscountPer, string> = { night: 'per night', stay: 'per stay' }

export interface DiscountInput {
  kind: DiscountKind
  /** Percent (0 to 100) or whole rupiah. */
  value: number
  /** For a rupiah discount: off every night or once off the stay. A percent applies to the stay either way. */
  per: DiscountPer
  reason: string
}

/** Who last priced a direct stay away from the list, and who allowed it past the limit. */
export interface PriceStamp {
  by: string
  byId: string
  on: IsoDate
  /** Why the rate was overridden; the discount carries its own reason. */
  reason: string
  /** Who allowed a price past the discount limit: the giver when they hold the right, else null. */
  approvedBy: string | null
}

/** A staff change to a direct stay's price. */
export interface PriceChange {
  /** Replaces the list price on every night; null keeps the list. */
  rateOverride: number | null
  discount: DiscountInput | null
  /** Why the rate was overridden; required with an override. */
  reason: string
}

interface PricedStay {
  /** The list price of each night, in stay order: the listing for a direct stay, the channel price for Airbnb. */
  listRates: readonly number[]
  rateOverride: number | null
  discount: Pick<DiscountInput, 'kind' | 'value' | 'per'> | null
}

const total = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)

const listPrice = (baseRate: number, dateRates: DateRates | undefined, date: IsoDate) => dateRates?.[date] ?? baseRate

/** The list price of each night from check-in to the night before check-out. */
export const quoteNights = (baseRate: number, dateRates: DateRates | undefined, checkIn: IsoDate, checkOut: IsoDate) =>
  Array.from({ length: Math.max(0, daysBetween(checkIn, checkOut)) }, (_, i) => listPrice(baseRate, dateRates, addDays(checkIn, i)))

/** Rupiah a discount takes off a subtotal, never more than the subtotal. */
function discountOff(subtotal: number, nights: number, d: PricedStay['discount']): number {
  if (!d) return 0
  const off = d.kind === 'percent' ? Math.round((subtotal * d.value) / 100) : d.per === 'night' ? d.value * nights : d.value
  return Math.min(subtotal, Math.max(0, off))
}

/** What each night costs after the override and the discount. The nights add up to the total exactly. */
export function nightCharges(s: PricedStay): number[] {
  const base = s.listRates.map((r) => s.rateOverride ?? r)
  const subtotal = total(base)
  const off = discountOff(subtotal, base.length, s.discount)
  if (off === 0) return base
  let given = 0
  return base.map((r, i) => {
    const share = i === base.length - 1 ? off - given : Math.floor((off * r) / subtotal)
    given += share
    return r - share
  })
}

export interface StayPrice {
  /** Every night at the list price. */
  list: number
  /** After the override, before the discount. */
  subtotal: number
  discount: number
  total: number
  /** How far under the list the guest pays, 0 to 1. */
  reduction: number
}

export function stayPrice(s: PricedStay): StayPrice {
  const list = total(s.listRates)
  const subtotal = s.rateOverride === null ? list : s.rateOverride * s.listRates.length
  const charged = total(nightCharges(s))
  return { list, subtotal, discount: subtotal - charged, total: charged, reduction: list > 0 ? Math.max(0, (list - charged) / list) : 0 }
}

/** Whether a price goes further under the list than `limitPct` allows without approval. */
export const beyondDiscountLimit = (price: StayPrice, limitPct: number) => price.reduction * 100 > limitPct + 1e-9

export function validatePriceChange(p: PriceChange): Record<string, string> {
  const errors: Record<string, string> = {}
  if (p.rateOverride !== null && (!Number.isInteger(p.rateOverride) || p.rateOverride <= 0)) errors.rateOverride = 'Enter the nightly rate in whole rupiah.'
  if (p.rateOverride !== null && p.discount === null && p.reason.trim().length < 3) errors.reason = 'Say why the rate changes.'
  if (p.discount) {
    const d = p.discount
    if (d.kind === 'percent' && !(d.value > 0 && d.value <= 100)) errors['discount.value'] = 'A percentage above 0, up to 100.'
    if (d.kind === 'amount' && (!Number.isInteger(d.value) || d.value <= 0)) errors['discount.value'] = 'Enter the discount in whole rupiah.'
    if (d.reason.trim().length < 3) errors['discount.reason'] = 'Say why the guest gets the discount.'
  }
  return errors
}

/**
 * List prices for new dates. Nights the stay already had keep the price they were sold at;
 * nights it gains take `priceFor`.
 */
export function repriceNights(stay: { checkIn: IsoDate; listRates: readonly number[] }, checkIn: IsoDate, checkOut: IsoDate, priceFor: (date: IsoDate) => number): number[] {
  return Array.from({ length: Math.max(0, daysBetween(checkIn, checkOut)) }, (_, i) => {
    const date = addDays(checkIn, i)
    const at = daysBetween(stay.checkIn, date)
    return at >= 0 && at < stay.listRates.length ? (stay.listRates[at] ?? priceFor(date)) : priceFor(date)
  })
}

