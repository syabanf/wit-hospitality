import { beforeEach, describe, expect, it } from 'vitest'
import { budgetRoomRevenue, EMPTY_BUDGET_MONTH } from '@/domain/revenue'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { createServices, type Services } from './services'

const TODAY = '2026-10-30'
let s: Services
const signIn = (who: string) => s.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
const filter = { from: '2026-10-01', to: TODAY, compare: 'previous' as const }

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
})

describe('revenue management', () => {
  it('agrees with the occupancy report on rooms, revenue, occupancy and ADR', async () => {
    const [d, occ] = await Promise.all([s.revenue.dashboard(filter), s.reports.run('occupancy', { from: filter.from, to: filter.to })])
    const total = (key: string) => occ.rows.reduce((a, r) => a + Number(r[key] ?? 0), 0)
    expect(d.current.available).toBe(total('sellable'))
    expect(d.current.sold).toBe(total('sold'))
    expect(d.current.revenue).toBe(total('revenue'))
    expect(d.kpis.occupancy.value).toBeCloseTo(total('sold') / total('sellable'))
    expect(d.previous).not.toBeNull()
    expect(d.kpis.revpar.change).not.toBeNull()
  })

  it('has no figures for last year, since the seed starts a few months back', async () => {
    const d = await s.revenue.dashboard({ ...filter, compare: 'last-year' })
    expect(d.lastYear).toBeNull()
    expect(d.previous).toBeNull()
    expect(d.kpis.adr.change).toBeNull()
    expect(d.trend).toHaveLength(12)
    expect(d.trend.filter((m) => m.hasData).length).toBeGreaterThan(2)
    expect(d.trend.filter((m) => !m.hasData).every((m) => m.revenue === 0)).toBe(true)
  })

  it('splits the mix by segment and narrows to one segment', async () => {
    const d = await s.revenue.dashboard(filter)
    expect(d.mix.map((m) => m.id)).toEqual(['direct', 'airbnb', 'corporate'])
    expect(d.mix.reduce((a, m) => a + m.value, 0)).toBe(d.current.revenue)
    const airbnb = await s.revenue.dashboard({ ...filter, segment: 'airbnb' })
    expect(airbnb.current.revenue).toBe(d.mix.find((m) => m.id === 'airbnb')?.value)
  })

  it('ranks villas by RevPAR and gives six months of pace with a forecast at or above the books', async () => {
    const d = await s.revenue.dashboard(filter)
    expect(d.villas.map((v) => v.revpar)).toEqual([...d.villas.map((v) => v.revpar)].sort((a, b) => b - a))
    expect(d.pace.map((p) => p.month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'])
    for (const p of d.pace) {
      expect(p.forecast.nights).toBeGreaterThanOrEqual(p.onBooks.nights)
      expect(p.forecast.nights).toBeLessThanOrEqual(p.available)
    }
    expect(d.pace[1]?.onBooks.nights).toBeGreaterThan(0)
  })

  it('seeds a budget for every villa that actuals land near, some months above and some below', async () => {
    const villas = (await s.revenue.options()).catalog.villas
    const signs = new Set<boolean>()
    for (const v of villas) {
      const b = await s.revenue.budget(2026, { villaId: v.id })
      expect(b.budget?.months).toHaveLength(12)
      for (const r of b.rows.filter((x) => x.actual && !x.partial && x.month >= '2026-09')) {
        const planned = budgetRoomRevenue(r.budget)
        if (!planned) continue
        const gap = ((r.actual?.roomRevenue ?? 0) - planned) / planned
        expect(Math.abs(gap), `${v.name} ${r.month}`).toBeLessThan(0.35)
        signs.add(gap > 0)
      }
    }
    expect(signs).toEqual(new Set([true, false]))
  })

  it('lets finance save a budget and refuses roles without Edit in Finance', async () => {
    const months = Array.from({ length: 12 }, () => ({ ...EMPTY_BUDGET_MONTH, roomNights: 100, adr: 2_000_000 }))
    await signIn('dian')
    await expect(s.revenue.saveBudget({ villaId: 'vil-saka', year: 2027, months })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('putu')
    await expect(s.revenue.saveBudget({ villaId: 'vil-saka', year: 2027, months })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('ida')
    await expect(s.revenue.saveBudget({ villaId: 'vil-saka', year: 2027, months: months.slice(1) })).rejects.toMatchObject({ errors: { months: 'A budget has twelve months.' } })
    await s.revenue.saveBudget({ villaId: 'vil-saka', year: 2027, months })
    expect((await s.revenue.budget(2027, { villaId: 'vil-saka' })).budget?.updatedBy).toBe('Ida Bagus Rai')
    expect(await s.revenue.copyFromLastYear('vil-saka', 2028)).toHaveLength(12)
    expect(await s.revenue.copyFromLastYear('vil-saka', 2026)).toBeNull()
  })

  it('runs the four reports', async () => {
    const range = { from: '2026-10-01', to: '2026-10-07' }
    const daily = await s.reports.run('rm-daily', range)
    expect(daily.rows).toHaveLength(7)
    const monthly = await s.reports.run('rm-monthly', { from: '2026-09-01', to: TODAY })
    expect(monthly.rows).toHaveLength(2 * 5)
    expect((await s.reports.run('rm-pace', range)).rows).toHaveLength(6)
    const budget = await s.reports.run('rm-budget', { from: '2026-09-01', to: TODAY, villaId: 'vil-saka' })
    expect(budget.rows.map((r) => r.month)).toEqual(['September 2026', 'October 2026'])
  })
})
