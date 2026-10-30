import { beforeEach, describe, expect, it } from 'vitest'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { createPerformance, type Performance } from './performance'
import { createServices, type Services } from './services'

const TODAY = '2026-10-05'
let s: Services
let p: Performance
const range = { from: '2026-09-01', to: TODAY, compareFrom: '2026-07-28', compareTo: '2026-08-31' }
const num = (v: unknown) => Number(v ?? 0)

beforeEach(() => {
  s = createServices(createMockPorts(fixedClock(TODAY), 0))
  p = createPerformance(s)
})

describe('owner performance', () => {
  it('reconciles the portfolio and every villa with the P&L reports', async () => {
    const view = await p.overview(range)
    const portfolio = await s.reports.run('pnl-portfolio', { from: range.from, to: range.to })
    expect(view.pnl.profit).toBe(portfolio.rows.reduce((t, r) => t + num(r.profit), 0))
    expect(view.pnl.revenue).toBe(portfolio.rows.reduce((t, r) => t + num(r.revenue), 0))
    const villas = await s.reports.run('pnl-villa', { from: range.from, to: range.to })
    for (const row of villas.rows) expect(view.villas.find((v) => v.name === row.villa)?.pnl.profit).toBe(num(row.profit))
    expect(view.villas[0]?.pnl.profit).toBeGreaterThanOrEqual(view.villas.at(-1)?.pnl.profit ?? 0)
    expect(view.kpis.occupancy.value).toBeGreaterThan(0.3)
    expect(view.kpis.adr.value).toBeGreaterThan(1_000_000)
    expect(view.trend).toHaveLength(6)
    expect(view.books.map((b) => b.days)).toEqual([30, 60, 90])
    expect(view.books[2]?.revenue).toBeGreaterThanOrEqual(view.books[0]?.revenue ?? 0)
    expect(view.changes.length).toBeGreaterThan(0)
    expect(view.costs.some((c) => c.id === 'payroll')).toBe(true)
  })

  it('narrows to one villa and matches its pnl-villa row', async () => {
    const view = await p.overview({ ...range, villaId: 'vil-tirta' })
    const row = (await s.reports.run('pnl-villa', { from: range.from, to: range.to, villaId: 'vil-tirta' })).rows[0]
    expect(view.pnl.profit).toBe(num(row?.profit))
    expect(view.villas.map((v) => v.id)).toEqual(['vil-tirta'])
    const villa = await p.villa('vil-tirta', range)
    expect(villa.pnl.profit).toBe(num(row?.profit))
    expect(villa.units).toHaveLength(4)
    expect(villa.months).toHaveLength(6)
  })

  it('builds a monthly owner statement with last month beside it', async () => {
    const st = await p.statement('2026-09')
    const sept = await s.reports.run('pnl-portfolio', { from: '2026-09-01', to: '2026-09-30' })
    expect(st.pnl.profit).toBe(num(sept.rows[0]?.profit))
    expect(st.sources.reduce((t, x) => t + x.revenue, 0)).toBe(st.pnl.revenue)
    expect(st.previous).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(st.cash.total).toBeGreaterThan(0)
    const villa = await p.statement('2026-10', 'vil-saka')
    expect(villa.range).toEqual({ from: '2026-10-01', to: TODAY })
    expect(villa.villa?.name).toBe('Villa Saka')
  })
})
