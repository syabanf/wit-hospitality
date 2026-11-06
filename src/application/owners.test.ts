import { beforeEach, describe, expect, it } from 'vitest'
import { GL } from '@/domain/journal'
import { statementFigures } from '@/domain/owner'
import { createMockPorts } from '@/infrastructure/mock'
import { pnlOf } from './performance'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'
const OCTOBER = '2026-10'
const range = { from: '2026-10-01', to: '2026-10-31', compareFrom: '2026-09-01', compareTo: '2026-09-30' }

describe('villa owners', () => {
  let svc: Services
  const clock = { date: TODAY, today() { return this.date } }
  const signIn = (who: string) => svc.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
  /** Each signer signs the entry while it waits and may; the last one posts it. */
  async function signAndPost(id: string, signers: readonly string[]) {
    for (const who of signers) {
      await signIn(who)
      if ((await svc.finance.transactions()).list.find((t) => t.id === id)?.status === 'submitted') await svc.finance.transition(id, 'approved').catch(() => undefined)
    }
    await svc.finance.transition(id, 'posted')
  }
  async function statementOf(contractId: string, month: string) {
    const st = (await svc.owners.statements(month)).rows.find((r) => r.contract.id === contractId)?.statement
    if (!st) throw new Error(`no ${month} statement for ${contractId}`)
    return st
  }

  beforeEach(() => {
    clock.date = TODAY
    svc = createServices(createMockPorts(clock, 0))
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

  it('seeds the last two months approved: the older one paid on the 10th, the latest waiting or carried forward', async () => {
    await signIn('ida')
    const september = await svc.owners.statements('2026-09')
    expect(september.rows.map((r) => [r.contract.id, r.statement?.status, r.statement?.payoutState, r.statement?.payout?.date])).toEqual([
      ['ct-karang', 'approved', 'paid', '2026-10-10'],
      ['ct-pandawa', 'approved', 'paid', '2026-10-10'],
      ['ct-lumbung', 'approved', 'paid', '2026-10-10'],
    ])
    const october = await svc.owners.statements(OCTOBER)
    for (const r of october.rows) {
      expect(r.statement?.status, r.contract.number).toBe('approved')
      expect(r.statement?.label, r.contract.number).toBe(r.payable > 0 ? 'Being approved' : 'Carried forward')
    }
    // The seed closes each month with the statement calculation, so it reads like the villa P&L.
    for (const r of [...september.rows, ...october.rows]) {
      const st = r.statement
      if (!st) throw new Error('not seeded')
      const row = (await svc.reports.run('pnl-villa', { from: `${st.month}-01`, to: st.month === OCTOBER ? range.to : range.compareTo, villaId: st.villaId })).rows[0]
      const pnl = row ? pnlOf(row) : null
      expect([st.figures.roomRevenue, st.figures.airbnbFees, st.figures.otherRevenue, st.figures.expenses, st.figures.payroll], st.number).toEqual([pnl?.revenue, pnl?.fees, pnl?.other, pnl?.expenses, pnl?.payroll].map((v) => (v ?? 0) + 0))
      expect(st.figures).toEqual(statementFigures(r.contract, st.figures))
    }

    await signIn('hendra')
    const mine = await svc.portal.statements()
    expect(mine.map((s) => [s.number, s.payoutState])).toEqual([
      ['OS-2026-10-KR', 'waiting'],
      ['OS-2026-10-PD', 'none'],
      ['OS-2026-09-KR', 'paid'],
      ['OS-2026-09-PD', 'paid'],
    ])
    await signIn('sophie')
    expect((await svc.portal.statements()).map((s) => s.label)).toEqual(['Being approved', 'Paid'])
  })

  it('reopens an unpaid statement, closes it again, and only shows it to the owner once approved', async () => {
    await signIn('ida')
    await expect(svc.owners.close('ct-karang', '2026-11', '')).rejects.toMatchObject({ code: 'STATEMENT_MONTH_OPEN' })
    const seeded = await statementOf('ct-karang', OCTOBER)
    await expect(svc.owners.close('ct-karang', OCTOBER, '')).rejects.toMatchObject({ code: 'STATEMENT_CLOSED' })
    await expect(svc.owners.close('ct-karang', '2026-08', '')).rejects.toMatchObject({ code: 'STATEMENT_ORDER' })
    await expect(svc.owners.reopen(seeded.id, 'Wrong fee')).rejects.toMatchObject({ code: 'PAYOUT_OPEN' })
    await expect(svc.owners.reopen((await statementOf('ct-karang', '2026-09')).id, 'Wrong fee')).rejects.toMatchObject({ code: 'STATEMENT_ORDER' })
    await signIn('rama')
    await svc.finance.transition(seeded.payoutTransactionId ?? '', 'rejected', 'Hold until the fee is checked')
    await signIn('hendra')
    await expect(svc.owners.reopen(seeded.id, 'Mine')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await signIn('ida')
    await expect(svc.owners.reopen(seeded.id, '')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await svc.owners.reopen(seeded.id, 'Fee to be checked')

    const draft = await svc.owners.statement('ct-karang', OCTOBER)
    expect(draft.statement).toBeNull()
    const f = draft.figures
    if (!f) throw new Error('no figures')
    expect(f).toEqual(seeded.figures)
    expect(f.roomRevenue).toBe(draft.stays.reduce((s, x) => s + x.revenue, 0))
    expect(f.ownerNights).toBe(3)
    expect(f.ownerStayCharge).toBe(350_000)
    expect(draft.settlement).toEqual({ broughtFrom: null, broughtForward: 0, payable: f.netPayable })

    const closed = await svc.owners.close('ct-karang', OCTOBER, '')
    expect(closed.figures).toEqual(f)
    await expect(svc.owners.approve(closed.id, '')).rejects.toMatchObject({ code: 'APPROVAL_ROLE' })
    await expect(svc.owners.pay(closed.id, 'bank-bca')).rejects.toMatchObject({ code: 'STATEMENT_NOT_APPROVED' })
    await signIn('hendra')
    expect((await svc.portal.statements()).map((s) => s.number)).not.toContain(closed.number)

    await signIn('rama')
    await svc.owners.approve(closed.id, 'Agreed')
    await signIn('hendra')
    const view = await svc.portal.statement(closed.id)
    expect(view.stays.every((s) => s.code === '' && s.bookingId === '')).toBe(true)
    await signIn('sophie')
    expect((await svc.portal.statements()).map((s) => s.number)).not.toContain(closed.number)

    await signIn('ida')
    const paying = await svc.owners.pay(closed.id, 'bank-bca')
    await expect(svc.owners.pay(closed.id, 'bank-bca')).rejects.toMatchObject({ code: 'PAYOUT_OPEN' })
    const payout = (await svc.finance.transactions()).list.find((t) => t.id === paying.payoutTransactionId)
    expect(payout).toMatchObject({ status: 'submitted', categoryId: 'cat-owner-payout', amount: f.netPayable, origin: 'owner_payout' })
    const report = await svc.reports.run('owner-statements', { from: range.from, to: range.to, villaId: 'vil-karang' })
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]).toMatchObject({ net: f.netPayable, brought: 0, payable: f.netPayable })
    expect((await svc.reports.run('owner-payouts', { from: range.from, to: range.to, villaId: 'vil-karang' })).rows[0]?.status).toBe('Being approved')
    await signAndPost(paying.payoutTransactionId ?? '', ['kadek', 'rama'])
    await signIn('ida')
    await expect(svc.owners.reopen(closed.id, 'Too late')).rejects.toMatchObject({ code: 'STATEMENT_PAID' })
  })

  it('carries a negative month forward: the next statement deducts it and pays only the remainder', async () => {
    await signIn('ida')
    const october = await statementOf('ct-pandawa', OCTOBER)
    const shortfall = -october.payable
    expect(shortfall).toBeGreaterThan(0)
    await expect(svc.owners.pay(october.id, 'bank-bca')).rejects.toMatchObject({ code: 'PAYOUT_NOTHING' })

    // December: November has ended, and a venue hire at Pandawa covered the shortfall.
    clock.date = '2026-12-02'
    await signIn('kadek')
    await svc.finance.createTransaction({ accountId: 'cb-uluwatu', kind: 'cash_in', categoryId: 'cat-extra', amount: 30_000_000, date: '2026-11-20', locationId: 'loc-uluwatu', villaId: 'vil-pandawa', unitId: null, bookingId: null, description: 'Wedding venue hire', reference: '', attachments: [] }, true)
    await signIn('ida')
    for (const t of (await svc.finance.transactions()).list.filter((x) => x.villaId === 'vil-pandawa' && x.status === 'submitted' && x.date.startsWith('2026-11'))) await signAndPost(t.id, ['kadek', 'rama', 'ida'])

    await signIn('ida')
    const draft = await svc.owners.statement('ct-pandawa', '2026-11')
    const net = draft.figures?.netPayable ?? 0
    const settled = { broughtFrom: OCTOBER, broughtForward: shortfall, payable: net - shortfall }
    expect(draft.settlement).toEqual(settled)
    const november = await svc.owners.close('ct-pandawa', '2026-11', '')
    expect(november).toMatchObject(settled)
    expect(november.payable).toBeGreaterThan(0)
    await signIn('rama')
    await svc.owners.approve(november.id, '')
    await signIn('ida')
    const paying = await svc.owners.pay(november.id, 'bank-bca')
    const payout = (await svc.finance.transactions()).list.find((t) => t.id === paying.payoutTransactionId)
    expect(payout?.amount).toBe(net - shortfall)
    await signAndPost(payout?.id ?? '', ['kadek', 'rama'])

    // The shortfall sat on the payable as a debit; November's credit covered it and the payout cleared the rest.
    const payable = (await svc.accounting.trialBalance({ villaId: 'vil-pandawa' })).rows.find((r) => r.account.id === GL.ownerPayable)
    expect((payable?.credit ?? 0) - (payable?.debit ?? 0)).toBe(0)
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)

    await signIn('hendra')
    const mine = await svc.portal.statements()
    expect(mine.find((s) => s.id === november.id)).toMatchObject({ ...settled, payoutState: 'paid' })
    expect(mine.find((s) => s.id === october.id)?.label).toBe('Carried forward')
    expect((await svc.portal.statement(november.id)).settlement).toEqual(settled)
  })
})
