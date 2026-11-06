import { describe, expect, it } from 'vitest'
import { DEFAULT_TAX_RATES, DEFAULT_TAX_SETTINGS, grossOf, nightSplits, ratesOn, rebateSplit, roundHalfUp, stayTax, taxNote, taxSplit, validateTaxSettings, withRates } from './tax'

const rates = DEFAULT_TAX_RATES

describe('service charge and PB1', () => {
  it('adds service and PB1 on a net room price, PB1 on the amount plus service', () => {
    const s = taxSplit(1_000_000, 'ROOM', rates, 'net')
    expect(s).toEqual({ net: 1_000_000, service: 100_000, pb1: 110_000 })
    expect(grossOf(s)).toBe(1_210_000)
  })

  it('derives the net from an inclusive price and leaves the rounding on PB1', () => {
    expect(taxSplit(1_210_000, 'ROOM', rates, 'inclusive')).toEqual({ net: 1_000_000, service: 100_000, pb1: 110_000 })
    // 1,000,000 / 1.21 = 826,446.28; service 82,644.6 rounds up; PB1 takes the rest.
    expect(taxSplit(1_000_000, 'ROOM', rates, 'inclusive')).toEqual({ net: 826_446, service: 82_645, pb1: 90_909 })
  })

  it('taxes each code as the settings say: laundry PB1 only, transfers and damage nothing', () => {
    expect(taxSplit(200_000, 'LDRY', rates, 'net')).toEqual({ net: 200_000, service: 0, pb1: 20_000 })
    expect(taxSplit(220_000, 'LDRY', rates, 'inclusive')).toEqual({ net: 200_000, service: 0, pb1: 20_000 })
    expect(taxSplit(350_000, 'TRNS', rates, 'net')).toEqual({ net: 350_000, service: 0, pb1: 0 })
    expect(taxSplit(350_000, 'DMG', rates, 'inclusive')).toEqual({ net: 350_000, service: 0, pb1: 0 })
  })

  it('follows the rate and the base the settings give', () => {
    expect(taxSplit(1_000_000, 'ROOM', { ...rates, pb1OnService: false }, 'net')).toEqual({ net: 1_000_000, service: 100_000, pb1: 100_000 })
    expect(taxSplit(1_000_000, 'FNB', { ...rates, servicePct: 11 }, 'net')).toEqual({ net: 1_000_000, service: 110_000, pb1: 111_000 })
    expect(taxSplit(1_000_000, 'ROOM', null, 'net')).toEqual({ net: 1_000_000, service: 0, pb1: 0 })
  })

  it('rounds to whole rupiah, half up', () => {
    expect([roundHalfUp(0.5), roundHalfUp(1.49), roundHalfUp(2.5), roundHalfUp(-2.5)]).toEqual([1, 1, 3, -3])
    // Service 0.5 rounds to 1; PB1 on 6 is 0.6, also 1.
    expect(taxSplit(5, 'ROOM', rates, 'net')).toEqual({ net: 5, service: 1, pb1: 1 })
  })

  it('takes a rebate’s share of the line’s tax back, to the rupiah over several rebates', () => {
    const line = { net: 1_000_000, service: 100_000, pb1: 110_000 }
    const first = rebateSplit(line, 0, 333_333)
    expect(first).toEqual({ net: 333_333, service: 33_333, pb1: 36_667 })
    const rest = rebateSplit(line, 333_333, 666_667)
    expect(first.service + rest.service).toBe(100_000)
    expect(first.pb1 + rest.pb1).toBe(110_000)
  })

  it('uses the rates in force on the posting date, so a later change leaves earlier postings alone', () => {
    const settings = { ...DEFAULT_TAX_SETTINGS, rates: withRates(DEFAULT_TAX_SETTINGS, { ...rates, effectiveFrom: '2026-12-01', servicePct: 11 }) }
    expect(ratesOn(settings, '2019-12-31')).toBeNull()
    expect(ratesOn(settings, '2026-11-30')?.servicePct).toBe(10)
    expect(ratesOn(settings, '2026-12-01')?.servicePct).toBe(11)
    const stay = { listRates: [1_000_000, 1_000_000], rateOverride: null, discount: null, checkIn: '2026-11-30', status: 'confirmed' as const, checkedOutOn: null, priceMode: 'net' as const }
    expect(nightSplits(stay, settings)).toEqual([
      { net: 1_000_000, service: 100_000, pb1: 110_000 },
      { net: 1_000_000, service: 110_000, pb1: 111_000 },
    ])
  })

  it('reads a stay without a price mode as inclusive, so what was paid stays the bill', () => {
    const before = { listRates: [1_210_000], rateOverride: null, discount: null, checkIn: '2026-10-01', status: 'checked_out' as const, checkedOutOn: '2026-10-02' }
    const t = stayTax(before, DEFAULT_TAX_SETTINGS)
    expect(t).toMatchObject({ mode: 'inclusive', net: 1_000_000, service: 100_000, pb1: 110_000, total: 1_210_000 })
    expect(taxNote(t)).toBe('Prices include 10% service and 10% PB1')
    expect(taxNote({ ...t, mode: 'net' })).toBe('Prices exclude 10% service and 10% PB1')
  })

  it('validates the settings', () => {
    const input = { rates: { ...rates, servicePct: 30 }, directMode: 'net' as const, regencies: { 'loc-ubud': '' } }
    expect(validateTaxSettings(input, ['ROOM'])).toMatchObject({ servicePct: expect.any(String), codes: expect.any(String), regencies: expect.any(String) })
  })
})
