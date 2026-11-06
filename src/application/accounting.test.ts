import { beforeEach, describe, expect, it } from 'vitest'
import { balance } from '@/domain/finance'
import { balanceSheet, buildJournals, cashGlId, chartOfAccounts, monthsSince, totalCredits, totalDebits, trialBalance, GL } from '@/domain/journal'
import { addDays, addMonths } from '@/lib/dates'
import { fixedClock } from '@/infrastructure/clock'
import { createMockPorts } from '@/infrastructure/mock'
import { buildState } from '@/infrastructure/mock/state'
import { createServices, type Services } from './services'

const TODAY = '2026-11-06'

describe('check the books', () => {
  const s = buildState(TODAY)
  const rebuilt = buildJournals({ cashAccounts: s.cashAccounts, transactions: s.transactions, periods: s.periods, loans: s.loans, map: s.categoryAccounts, categories: s.categories })
  const chart = chartOfAccounts(s.cashAccounts)

  it('rebuilds the seeded journal from the cash ledger', () => {
    expect(rebuilt.map((e) => e.lines)).toEqual(s.journals.map((e) => e.lines))
    expect(rebuilt.some((e) => e.source === 'opening')).toBe(true)
    expect(rebuilt.filter((e) => e.source === 'payroll')).toHaveLength(2)
    expect(rebuilt.some((e) => e.source === 'transfer')).toBe(true)
  })

  it('balances every entry', () => {
    for (const e of rebuilt) expect(totalDebits(e.lines), e.memo).toBe(totalCredits(e.lines))
  })

  it('nets the trial balance to zero and balances the sheet at every month end', () => {
    const first = rebuilt.reduce((min, e) => (e.date < min ? e.date : min), TODAY)
    for (const month of monthsSince(first, TODAY)) {
      const end = addDays(addMonths(`${month}-01`, 1), -1)
      const tb = trialBalance(chart, rebuilt, { to: end })
      expect(tb.debit, month).toBe(tb.credit)
      const bs = balanceSheet(chart, rebuilt, { asOf: end })
      expect(bs.totalAssets, month).toBe(bs.totalLiabilities + bs.totalEquity)
    }
  })

  it('keeps every cash GL account equal to its cash ledger balance', () => {
    const tb = trialBalance(chart, rebuilt, {})
    for (const a of s.cashAccounts) {
      const row = tb.rows.find((r) => r.account.id === cashGlId(a.id))
      expect((row?.debit ?? 0) - (row?.credit ?? 0), a.name).toBe(balance(a, s.transactions))
    }
    const loans = tb.rows.find((r) => r.account.id === GL.employeeLoans)
    expect((loans?.debit ?? 0) - (loans?.credit ?? 0)).toBe(s.loans.filter((l) => l.status === 'active').reduce((sum, l) => sum + l.amount - l.repaid, 0))
  })
})

describe('accounting use cases', () => {
  let svc: Services
  const signIn = (who: string) => svc.access.login({ email: `${who}@balivillas.id`, password: 'villa123' })
  beforeEach(() => {
    svc = createServices(createMockPorts(fixedClock(TODAY), 0))
  })

  it('writes a journal entry when an entry posts and the reversing entry on reversal', async () => {
    await signIn('kadek')
    const t = await svc.finance.createTransaction({ accountId: 'cb-ubud', kind: 'cash_out', categoryId: 'cat-util', amount: 400_000, date: TODAY, locationId: 'loc-ubud', villaId: 'vil-tirta', unitId: null, bookingId: null, description: 'Gas refill', reference: '', attachments: [] }, true)
    await signIn('rama')
    await svc.finance.transition(t.id, 'approved')
    await svc.finance.transition(t.id, 'posted')
    const reversal = await svc.finance.reverse(t.id, 'Charged twice')
    const { views } = await svc.accounting.journals()
    const posted = views.find((e) => e.sourceId === t.id)
    expect(posted?.lines.map((l) => [l.account.id, l.debit, l.credit])).toEqual([['gl-6200', 400_000, 0], [cashGlId('cb-ubud'), 0, 400_000]])
    expect(posted?.href).toBe(`/finance/transactions/${t.id}`)
    expect(views.find((e) => e.sourceId === reversal.id)?.lines.map((l) => [l.account.id, l.debit, l.credit])).toEqual([[cashGlId('cb-ubud'), 400_000, 0], ['gl-6200', 0, 400_000]])
    const tb = await svc.accounting.trialBalance({})
    expect(tb.debit).toBe(tb.credit)
  })

  it('maps a category to another account for new postings only', async () => {
    const before = (await svc.accounting.journals()).views.length
    await expect(svc.accounting.mapCategory('cat-util', cashGlId('bank-bca'))).rejects.toMatchObject({ code: 'LEDGER_ACCOUNT_INVALID' })
    await svc.accounting.mapCategory('cat-util', 'gl-6400')
    expect((await svc.accounting.categoryAccounts()).categories.find((c) => c.id === 'cat-util')?.accountId).toBe('gl-6400')
    expect((await svc.accounting.journals()).views).toHaveLength(before)
  })

  it('signs a manual journal through the chain and posts it', async () => {
    await signIn('ida')
    const lines = [{ accountId: GL.receivable, debit: 2_000_000, credit: 0 }, { accountId: GL.roomRevenue, debit: 0, credit: 2_000_000 }]
    await expect(svc.accounting.createManualJournal({ date: TODAY, villaId: 'vil-saka', memo: 'Accrue an unpaid stay', lines: [lines[0]!, { ...lines[1]!, credit: 1_000_000 }], attachments: [] }, true)).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' })
    const m = await svc.accounting.createManualJournal({ date: TODAY, villaId: 'vil-saka', memo: 'Accrue an unpaid stay', lines, attachments: [] }, true)
    expect(m.status).toBe('submitted')
    await expect(svc.accounting.transitionManualJournal(m.id, 'approved')).rejects.toMatchObject({ code: 'APPROVAL_SELF' })
    await signIn('kadek')
    await svc.accounting.transitionManualJournal(m.id, 'approved')
    await signIn('ida')
    const posted = await svc.accounting.transitionManualJournal(m.id, 'posted')
    expect(posted.journalId).not.toBeNull()
    expect((await svc.accounting.journal(posted.journalId ?? '')).href).toBe(`/accounting/manual/${m.id}`)
  })

  it('closes a month and refuses posting into it until it reopens', async () => {
    await signIn('ida')
    const periods = await svc.accounting.periods()
    expect(periods[0]?.month).toBe('2026-11')
    await expect(svc.accounting.closePeriod('2026-11', '')).rejects.toMatchObject({ code: 'PERIOD_NOT_ENDED' })
    const october = periods.find((p) => p.month === '2026-10')
    if (october?.pending) await expect(svc.accounting.closePeriod('2026-10', '')).rejects.toMatchObject({ code: 'PERIOD_PENDING' })
    await svc.accounting.closePeriod('2026-08', 'August books final')
    const m = await svc.accounting.createManualJournal({ date: '2026-08-31', villaId: null, memo: 'Late accrual', lines: [{ accountId: GL.receivable, debit: 100_000, credit: 0 }, { accountId: GL.otherIncome, debit: 0, credit: 100_000 }], attachments: [] }, true)
    await signIn('rama')
    await svc.accounting.transitionManualJournal(m.id, 'approved')
    await expect(svc.accounting.transitionManualJournal(m.id, 'posted')).rejects.toMatchObject({ code: 'PERIOD_CLOSED' })
    await svc.accounting.reopenPeriod('2026-08', 'Late accrual found')
    expect((await svc.accounting.transitionManualJournal(m.id, 'posted')).status).toBe('posted')
  })

  it('serves the statements as reports', async () => {
    const tb = await svc.reports.run('trial-balance', { to: TODAY })
    const sum = (key: string) => tb.rows.reduce((s, r) => s + Number(r[key] ?? 0), 0)
    expect(sum('debit')).toBe(sum('credit'))
    const bs = await svc.reports.run('balance-sheet', { to: TODAY })
    expect(bs.rows.reduce((s, r) => s + Number(r.assets), 0)).toBe(bs.rows.reduce((s, r) => s + Number(r.claims), 0))
    const is = await svc.reports.run('income-statement', { from: '2026-10-01', to: '2026-10-31' })
    expect(is.rows.length).toBeGreaterThan(0)
    expect((await svc.reports.run('general-journal', { from: '2026-10-01', to: '2026-10-31' })).rows.length).toBeGreaterThan(0)
  })
})
