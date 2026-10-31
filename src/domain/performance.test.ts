import { describe, expect, it } from 'vitest'
import { compareRange, describeChanges, monthsIn, onTheBooks, operatingMargin, ownerRange, roomKpis, type PnlLine } from './performance'

const line = (over: Partial<PnlLine>): PnlLine => ({ revenue: 0, fees: 0, other: 0, expenses: 0, payroll: 0, profit: 0, ...over })

describe('owner performance helpers', () => {
  it('turns presets into inclusive ranges that stop at today', () => {
    expect(ownerRange('month', '2026-10-30')).toEqual({ from: '2026-10-01', to: '2026-10-30' })
    expect(ownerRange('last-month', '2026-10-30')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(ownerRange('quarter', '2026-11-12')).toEqual({ from: '2026-10-01', to: '2026-11-12' })
    expect(ownerRange('ytd', '2026-10-30')).toEqual({ from: '2026-01-01', to: '2026-10-30' })
    expect(ownerRange('custom', '2026-10-30', { from: '2026-10-10', to: '2026-12-01' })).toEqual({ from: '2026-10-10', to: '2026-10-30' })
  })

  it('compares with the days just before or the same dates last year', () => {
    expect(compareRange({ from: '2026-10-01', to: '2026-10-30' }, 'previous')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(compareRange({ from: '2026-10-01', to: '2026-10-30' }, 'last-year')).toEqual({ from: '2025-10-01', to: '2025-10-30' })
  })

  it('splits a range into clipped months', () => {
    expect(monthsIn({ from: '2026-08-15', to: '2026-10-05' })).toEqual([
      { month: '2026-08', from: '2026-08-15', to: '2026-08-31' },
      { month: '2026-09', from: '2026-09-01', to: '2026-09-30' },
      { month: '2026-10', from: '2026-10-01', to: '2026-10-05' },
    ])
  })

  it('computes occupancy, ADR, RevPAR and margin without dividing by zero', () => {
    expect(roomKpis(10_000_000, 5, 20)).toEqual({ occupancy: 0.25, adr: 2_000_000, revpar: 500_000 })
    expect(roomKpis(0, 0, 0)).toEqual({ occupancy: 0, adr: 0, revpar: 0 })
    expect(operatingMargin(line({ revenue: 800, other: 200, profit: 250 }))).toBe(0.25)
    expect(operatingMargin(line({}))).toBe(0)
  })

  it('counts confirmed and in-house nights inside the window only', () => {
    const stays = [
      { status: 'confirmed', checkIn: '2026-10-03', checkOut: '2026-10-08', listRates: [100, 100, 100, 100, 100], rateOverride: null, discount: null },
      { status: 'checked_in', checkIn: '2026-09-30', checkOut: '2026-10-02', listRates: [50, 50], rateOverride: null, discount: null },
      { status: 'cancelled', checkIn: '2026-10-03', checkOut: '2026-10-05', listRates: [999, 999], rateOverride: null, discount: null },
    ] as const
    expect(onTheBooks(stays, 2, '2026-10-01', 5)).toEqual({ days: 5, revenue: 50 + 300, nights: 4, occupancy: 0.4 })
  })

  it('writes the largest movements as sentences with their main driver', () => {
    const fmt = (v: number) => `Rp ${v}`
    const changes = describeChanges(
      { current: line({ revenue: 500, profit: 300 }), previous: line({ revenue: 400, profit: 220 }) },
      [
        { name: 'Villa Saka', current: line({ revenue: 300, profit: 200 }), previous: line({ revenue: 200, profit: 100 }) },
        { name: 'Villa Tirta', current: line({ revenue: 200, expenses: 50, profit: 100 }), previous: line({ revenue: 200, expenses: 30, profit: 120 }) },
        { name: 'Villa Karang', current: line({ profit: 10 }), previous: line({ profit: 10 }) },
      ],
      fmt,
    )
    expect(changes.map((c) => c.text)).toEqual([
      'Portfolio profit up Rp 80, mostly from room revenue going up.',
      'Villa Saka profit up Rp 100, mostly from room revenue going up.',
      'Villa Tirta profit down Rp 20, mostly from operating expenses going up.',
    ])
  })
})
