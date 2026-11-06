import { describe, expect, it } from 'vitest'
import { priceSourceLabel } from './pricing'
import { listNights, planNight, priceListFor, seasonOn, soldNights, validateRatePlan, type RatePlan } from './ratePlan'

const plan: RatePlan = {
  groupId: 'grp-a',
  weekdayRate: 1_000_000,
  weekendRate: 1_200_000,
  seasons: [
    { name: 'High season', from: '12-20', to: '01-05', kind: 'surcharge', value: 40 },
    { name: 'New Year week', from: '12-28', to: '01-02', kind: 'fixed', value: 3_000_000 },
  ],
}

describe('rate plans', () => {
  it('prices weekday and weekend nights, Friday and Saturday at the weekend rate', () => {
    // 2026-11-19 is a Thursday.
    expect(['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((d) => planNight(plan, d))).toEqual([
      { rate: 1_000_000, name: 'Weekday' },
      { rate: 1_200_000, name: 'Weekend' },
      { rate: 1_200_000, name: 'Weekend' },
      { rate: 1_000_000, name: 'Weekday' },
    ])
  })

  it('adds a surcharge to the night rate, across the new year', () => {
    expect(planNight(plan, '2026-12-21')).toEqual({ rate: 1_400_000, name: 'High season' })
    expect(planNight(plan, '2027-01-08')).toEqual({ rate: 1_200_000, name: 'Weekend' })
    expect(planNight(plan, '2027-01-04')).toEqual({ rate: 1_400_000, name: 'High season' })
  })

  it('lets the narrower season win where two overlap, whatever the order', () => {
    expect(planNight(plan, '2026-12-31')).toEqual({ rate: 3_000_000, name: 'New Year week' })
    const reversed = { ...plan, seasons: [...plan.seasons].reverse() }
    expect(seasonOn(reversed, '2026-12-31')?.name).toBe('New Year week')
    expect(seasonOn(reversed, '2026-12-27')?.name).toBe('High season')
    // Equal length: the season listed last wins.
    const twins = { seasons: [{ ...plan.seasons[1]!, name: 'A' }, { ...plan.seasons[1]!, name: 'B' }] }
    expect(seasonOn(twins, '2026-12-30')?.name).toBe('B')
  })

  it('takes the live listing first, the rate plan second, and nothing otherwise', () => {
    const live = { status: 'active' as const, dateRates: { '2026-11-20': 1_500_000 } }
    const listed = priceListFor({ groupId: 'grp-a' }, live, [plan])
    expect(listed?.kind).toBe('listing')
    if (listed) expect(listNights(listed, 900_000, '2026-11-19', '2026-11-21').map((n) => [n.rate, priceSourceLabel(n.source)])).toEqual([[900_000, 'Airbnb listing'], [1_500_000, 'Airbnb listing']])
    const fallback = priceListFor({ groupId: 'grp-a' }, { ...live, status: 'paused' }, [plan])
    expect(fallback?.kind).toBe('plan')
    if (fallback) expect(listNights(fallback, 900_000, '2026-11-20', '2026-11-21').map((n) => priceSourceLabel(n.source))).toEqual(['Rate plan: Weekend'])
    expect(priceListFor({ groupId: null }, null, [plan])).toBeNull()
    expect(priceListFor({ groupId: 'grp-b' }, undefined, [plan])).toBeNull()
  })

  it('reads the sold nights with their sources, older stays falling back to the listing or the channel', () => {
    expect(soldNights({ source: 'direct', checkIn: '2026-11-19', listRates: [1, 2], listSources: [{ kind: 'plan', name: 'Weekday' }, { kind: 'listing' }] }).map((n) => n.source.kind)).toEqual(['plan', 'listing'])
    expect(soldNights({ source: 'airbnb', checkIn: '2026-11-19', listRates: [5] })).toEqual([{ date: '2026-11-19', rate: 5, source: { kind: 'channel' } }])
  })

  it('validates rates and seasons', () => {
    expect(validateRatePlan(plan)).toEqual({})
    expect(validateRatePlan({ weekdayRate: 0, weekendRate: 1.5, seasons: [{ name: 'x', from: '02-30', to: '13-01', kind: 'surcharge', value: 500 }] })).toEqual({
      weekdayRate: 'Enter the weekday rate in whole rupiah.',
      weekendRate: 'Enter the weekend rate in whole rupiah.',
      'seasons.0.name': 'Name the season.',
      'seasons.0.from': 'Pick the first night.',
      'seasons.0.to': 'Pick the last night.',
      'seasons.0.value': 'A whole percentage above 0, up to 300.',
    })
    expect(validateRatePlan({ ...plan, seasons: [{ name: 'Leap', from: '02-29', to: '02-29', kind: 'fixed', value: 0 }] })).toEqual({ 'seasons.0.value': 'Enter the nightly price in whole rupiah.' })
  })
})
