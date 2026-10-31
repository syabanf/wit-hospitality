import type { DiscountKind, DiscountPer, PriceChange, StayPrice } from '@/domain/pricing'

/** What the price fields hold while typed; empty strings mean "keep the list". */
export interface PriceDraft {
  override: string
  reason: string
  discount: DiscountKind | 'none'
  value: string
  per: DiscountPer
  discountReason: string
}

export const EMPTY_PRICE: PriceDraft = { override: '', reason: '', discount: 'none', value: '', per: 'stay', discountReason: '' }

export const priceDraftOf = (b: { rateOverride: number | null; discount: { kind: DiscountKind; value: number; per: DiscountPer; reason: string } | null; priceSetBy: { reason: string } | null }): PriceDraft => ({
  override: b.rateOverride === null ? '' : String(b.rateOverride),
  reason: b.priceSetBy?.reason ?? '',
  discount: b.discount?.kind ?? 'none',
  value: b.discount ? String(b.discount.value) : '',
  per: b.discount?.per ?? 'stay',
  discountReason: b.discount?.reason ?? '',
})

/** The staff price the draft describes, or null when it keeps the list price untouched. */
export function toPriceChange(d: PriceDraft): PriceChange | null {
  const rateOverride = d.override.trim() ? Number(d.override) : null
  const discount = d.discount === 'none' ? null : { kind: d.discount, value: Number(d.value), per: d.per, reason: d.discountReason }
  return rateOverride === null && !discount ? null : { rateOverride, discount, reason: d.reason }
}

export interface PriceQuote {
  price: StayPrice
  limitPct: number
  beyondLimit: boolean
  mayApprove: boolean
}
