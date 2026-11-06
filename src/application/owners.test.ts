import { beforeEach, describe, expect, it } from 'vitest'
import { statementFigures } from '@/domain/owner'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'
const OCTOBER = '2026-10'
const range = { from: '2026-10-01', to: '2026-10-31', compareFrom: '2026-09-01', compareTo: '2026-09-30' }

describe('villa owners', () => {
  let svc: Services
  const signIn = (who: string) => svc.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })

  beforeEach(() => {
    svc = createServices(createMockPorts(fixedClock(TODAY), 0))
  })

  it('seeds two investors: Karang and Pandawa to one, Lumbung to the other, Saka and Tirta the operator’s', async () => {
    await signIn('ida')
    const { contracts } = await svc.owners.overview()
    const byVilla = Object.fromEntries(contracts.map((c) => [c.villaId, c.ownerName]))
    expect(byVilla).toEqual({ 'vil-karang': 'Hendra Gunawan', 'vil-pandawa': 'Hendra Gunawan', 'vil-lumbung': 'Sophie Laurent' })
  })

  it('keeps a villa owner out of every operational module', async () => {
    await signIn('hendra')
    await expect(svc.booking.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(svc.finance.transactions()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(svc.reports.run('pnl-villa', { from: range.from, to: range.to })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(svc.owners.overview()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(svc.owners.close('ct-karang', OCTOBER, '')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('shows a villa owner their own villas only, the calendar without guests', async () => {
    await signIn('hendra')
    const perf = await svc.portal.performance(range)
    expect(perf.villas.map((v) => v.name).sort()).toEqual(['Villa Karang', 'Villa Pandawa'])
    expect(perf.kpis.revenue.value).toBeGreaterThan(0)
    const cal = await svc.portal.calendar('2026-10-01', 31)
    expect(new Set(cal.units.map((u) => u.villaId))).toEqual(new Set(['vil-karang', 'vil-pandawa']))
    expect(cal.spans.some((s) => s.kind === 'stay')).toBe(true)
    expect(cal.spans.some((s) => s.kind === 'owner')).toBe(true)
    for (const s of cal.spans) expect(Object.keys(s).sort()).toEqual(['from', 'id', 'kind', 'label', 'to', 'unitCode', 'unitId'])

    await signIn('sophie')
    expect((await svc.portal.performance(range)).villas.map((v) => v.name)).toEqual(['Villa Lumbung'])
    await expect(svc.portal.requestStay({ contractId: 'ct-karang', checkIn: '2026-12-01', checkOut: '2026-12-03', guests: 2, note: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(svc.portal.requestStay({ contractId: 'ct-lumbung', checkIn: '2026-12-01', checkOut: '2027-01-02', guests: 2, note: '' })).rejects.toMatchObject({ code: 'OWNER_NIGHTS_EXCEEDED' })
    const asked = await svc.portal.requestStay({ contractId: 'ct-lumbung', checkIn: '2026-12-01', checkOut: '2026-12-04', guests: 2, note: 'Christmas shopping' })
    expect(asked.status).toBe('pending')

    await signIn('kadek')
    const overview = await svc.owners.overview()
    expect(overview.stays.find((r) => r.id === asked.id)?.ownerName).toBe('Sophie Laurent')
    const lofts = overview.catalog.units.filter((u) => u.villaId === 'vil-lumbung')
    let decided = null
    for (const u of lofts) decided ??= await svc.owners.decideStay(asked.id, { approve: true, unitId: u.id, note: '' }).catch(() => null)
    expect(decided).toMatchObject({ status: 'approved', blockId: expect.any(String) })
    await expect(svc.owners.decideStay(asked.id, { approve: false, note: 'Too late' })).rejects.toMatchObject({ code: 'OWNER_STAY_DECIDED' })
  })

  it('closes, approves and pays a statement, and only then shows it to the owner', async () => {
    await signIn('ida')
    await expect(svc.owners.close('ct-karang', '2026-11', '')).rejects.toMatchObject({ code: 'STATEMENT_MONTH_OPEN' })
    const draft = await svc.owners.statement('ct-karang', OCTOBER)
    expect(draft.statement).toBeNull()
    const f = draft.figures
    if (!f) throw new Error('no figures')
    expect(f.roomRevenue).toBe(draft.stays.reduce((s, x) => s + x.revenue, 0))
    expect(f).toEqual(statementFigures(draft.contract, f))
    expect(f.ownerNights).toBe(3)
    expect(f.ownerStayCharge).toBe(350_000)

    const closed = await svc.owners.close('ct-karang', OCTOBER, '')
    expect(closed.figures).toEqual(f)
    await expect(svc.owners.close('ct-karang', OCTOBER, '')).rejects.toMatchObject({ code: 'STATEMENT_CLOSED' })
    await expect(svc.owners.approve(closed.id, '')).rejects.toMatchObject({ code: 'APPROVAL_ROLE' })
    await expect(svc.owners.pay(closed.id, 'bank-bca')).rejects.toMatchObject({ code: 'STATEMENT_NOT_APPROVED' })

    await signIn('hendra')
    expect(await svc.portal.statements()).toHaveLength(0)

    await signIn('rama')
    await svc.owners.approve(closed.id, 'Agreed')
    await signIn('hendra')
    const mine = await svc.portal.statements()
    expect(mine.map((s) => s.number)).toEqual([closed.number])
    const view = await svc.portal.statement(closed.id)
    expect(view.stays.every((s) => s.code === '' && s.bookingId === '')).toBe(true)
    await signIn('sophie')
    expect(await svc.portal.statements()).toHaveLength(0)

    await signIn('ida')
    const paying = await svc.owners.pay(closed.id, 'bank-bca')
    await expect(svc.owners.pay(closed.id, 'bank-bca')).rejects.toMatchObject({ code: 'PAYOUT_OPEN' })
    const payout = (await svc.finance.transactions()).list.find((t) => t.id === paying.payoutTransactionId)
    expect(payout).toMatchObject({ status: 'submitted', categoryId: 'cat-owner-payout', amount: f.netPayable, origin: 'owner_payout' })
    const report = await svc.reports.run('owner-statements', { from: range.from, to: range.to })
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]?.net).toBe(f.netPayable)
    expect((await svc.reports.run('owner-payouts', { from: range.from, to: range.to })).rows[0]?.status).toBe('Being approved')
  })
})
