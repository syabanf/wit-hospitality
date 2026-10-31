import { describe, expect, it } from 'vitest'
import { beyondDiscountLimit, nightCharges, quoteNights, repriceNights, stayPrice, validatePriceChange } from './pricing'

const stay = (listRates: number[], extra: Partial<Parameters<typeof stayPrice>[0]> = {}) => ({ listRates, rateOverride: null, discount: null, ...extra })

describe('pricing', () => {
  it('quotes each night from the listing, falling back to the base rate', () => {
    expect(quoteNights(1_000_000, { '2026-11-20': 1_200_000 }, '2026-11-19', '2026-11-22')).toEqual([1_000_000, 1_200_000, 1_000_000])
    expect(quoteNights(1_000_000, undefined, '2026-11-19', '2026-11-19')).toEqual([])
  })

  it('spreads a discount over the nights so they add up to the total exactly', () => {
    const percent = stay([1_000_000, 1_150_000, 1_150_000], { discount: { kind: 'percent', value: 7, per: 'stay' } })
    expect(nightCharges(percent).reduce((s, v) => s + v, 0)).toBe(stayPrice(percent).total)
    expect(stayPrice(percent)).toMatchObject({ list: 3_300_000, subtotal: 3_300_000, discount: 231_000, total: 3_069_000 })
    expect(stayPrice(stay([500_000, 500_000], { discount: { kind: 'amount', value: 100_000, per: 'night' } })).total).toBe(800_000)
    expect(stayPrice(stay([500_000, 500_000], { discount: { kind: 'amount', value: 100_000, per: 'stay' } })).total).toBe(900_000)
    expect(stayPrice(stay([500_000], { discount: { kind: 'amount', value: 900_000, per: 'stay' } })).total).toBe(0)
  })

  it('measures a staff rate and a discount against the list for the limit', () => {
    const override = stayPrice(stay([1_000_000, 1_000_000], { rateOverride: 850_000 }))
    expect(override).toMatchObject({ subtotal: 1_700_000, discount: 0, total: 1_700_000 })
    expect(override.reduction).toBeCloseTo(0.15)
    expect(beyondDiscountLimit(override, 10)).toBe(true)
    expect(beyondDiscountLimit(override, 15)).toBe(false)
    expect(beyondDiscountLimit(stayPrice(stay([1_000_000], { rateOverride: 1_200_000 })), 0)).toBe(false)
  })

  it('keeps the price of nights already sold when a stay changes', () => {
    const sold = { checkIn: '2026-11-19', listRates: [900_000, 950_000] }
    expect(repriceNights(sold, '2026-11-20', '2026-11-23', () => 1_000_000)).toEqual([950_000, 1_000_000, 1_000_000])
  })

  it('asks for a reason and a sane value', () => {
    expect(validatePriceChange({ rateOverride: 900_000, discount: null, reason: '' })).toHaveProperty('reason')
    expect(validatePriceChange({ rateOverride: null, discount: { kind: 'percent', value: 120, per: 'stay', reason: 'x' }, reason: '' })).toMatchObject({ 'discount.value': expect.any(String), 'discount.reason': expect.any(String) })
    expect(validatePriceChange({ rateOverride: null, discount: { kind: 'amount', value: 50_000, per: 'night', reason: 'Long stay' }, reason: '' })).toEqual({})
  })
})
