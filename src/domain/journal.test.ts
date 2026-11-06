import { describe, expect, it } from 'vitest'
import type { CashAccount, Category, Transaction } from './finance'
import {
  assertBalanced,
  assertClosable,
  assertOpenPeriod,
  balanceSheet,
  buildJournals,
  cashGlId,
  chartOfAccounts,
  generalLedger,
  GL,
  incomeStatement,
  journalFor,
  monthsSince,
  payrollJournal,
  totalCredits,
  totalDebits,
  trialBalance,
  validateManualJournal,
  validateMapping,
  DEFAULT_CATEGORY_ACCOUNTS,
} from './journal'
import type { PayrollPeriod } from './payroll'

const account = (id: string, openingBalance: number): CashAccount => ({ id, name: id, kind: 'cashbox', locationId: 'loc-a', villaId: null, floatLimit: null, custodianId: null, openingBalance, openedOn: '2026-09-01' })
const accounts = [account('cb', 1_000_000), account('bank', 5_000_000)]
const chart = chartOfAccounts(accounts)
const categories: Category[] = [
  { id: 'cat-room', name: 'Room revenue', kind: 'cash_in', slot: 1, active: true, villaIds: [] },
  { id: 'cat-util', name: 'Utilities', kind: 'cash_out', slot: 1, active: true, villaIds: [] },
  { id: 'cat-new', name: 'New', kind: 'cash_out', slot: 0, active: true, villaIds: [] },
]

let n = 0
const tx = (fields: Partial<Transaction>): Transaction => ({
  id: `tx-${++n}`,
  number: `TX-${n}`,
  accountId: 'cb',
  kind: 'cash_in',
  categoryId: 'cat-room',
  amount: 100_000,
  date: '2026-09-10',
  locationId: 'loc-a',
  villaId: 'vil-a',
  unitId: null,
  bookingId: null,
  description: 'Entry',
  reference: '',
  attachments: [],
  origin: 'manual',
  status: 'posted',
  approvals: [],
  history: [],
  rejectionReason: null,
  transferId: null,
  reversalOf: null,
  reversedBy: null,
  createdBy: 'A',
  createdById: 'usr-a',
  createdOn: '2026-09-10',
  ...fields,
})
const books = (transactions: Transaction[], periods: PayrollPeriod[] = []) => ({ transactions, periods, map: DEFAULT_CATEGORY_ACCOUNTS, categories })

describe('journal', () => {
  it('refuses entries whose debits and credits differ', () => {
    expect(() => assertBalanced([{ accountId: 'a', debit: 100, credit: 0 }, { accountId: 'b', debit: 0, credit: 90 }])).toThrow(expect.objectContaining({ code: 'JOURNAL_UNBALANCED' }))
    expect(() => assertBalanced([{ accountId: 'a', debit: 100, credit: 100 }, { accountId: 'b', debit: 0, credit: 0 }])).toThrow(expect.objectContaining({ code: 'JOURNAL_UNBALANCED' }))
    expect(() => assertBalanced([{ accountId: 'a', debit: 100, credit: 0 }])).toThrow(expect.objectContaining({ code: 'JOURNAL_UNBALANCED' }))
    expect(() => assertBalanced([{ accountId: 'a', debit: 100, credit: 0 }, { accountId: 'b', debit: 0, credit: 100 }])).not.toThrow()
  })

  it('books cash in against revenue and cash out against the expense, with a fallback for unmapped categories', () => {
    const income = journalFor(tx({ kind: 'cash_in', categoryId: 'cat-room' }), books([]))
    expect(income.lines).toEqual([{ accountId: cashGlId('cb'), debit: 100_000, credit: 0 }, { accountId: GL.roomRevenue, debit: 0, credit: 100_000, code: 'ROOM' }])
    const spend = journalFor(tx({ kind: 'cash_out', categoryId: 'cat-util' }), books([]))
    expect(spend.lines).toEqual([{ accountId: 'gl-6200', debit: 100_000, credit: 0 }, { accountId: cashGlId('cb'), debit: 0, credit: 100_000 }])
    expect(journalFor(tx({ kind: 'cash_out', categoryId: 'cat-new' }), books([])).lines[0]?.accountId).toBe(GL.otherExpense)
  })

  it('writes one entry for both halves of a transfer, and the reversal undoes the original', () => {
    const out = tx({ kind: 'cash_out', accountId: 'bank', categoryId: 'cat-transfer-out', transferId: 'trf-1', origin: 'transfer' })
    const into = tx({ kind: 'cash_in', accountId: 'cb', categoryId: 'cat-transfer-in', transferId: 'trf-1', origin: 'transfer' })
    const fromOut = journalFor(out, books([out, into]))
    expect(journalFor(into, books([out, into]))).toEqual(fromOut)
    expect(fromOut.lines).toEqual([{ accountId: cashGlId('cb'), debit: 100_000, credit: 0 }, { accountId: cashGlId('bank'), debit: 0, credit: 100_000 }])
    const spend = tx({ kind: 'cash_out', categoryId: 'cat-util', status: 'reversed' })
    const reversal = tx({ kind: 'cash_in', categoryId: 'cat-util', reversalOf: spend.id, origin: 'reversal' })
    const all = buildJournals({ ...books([spend, reversal]), cashAccounts: [], loans: [] })
    expect(trialBalance(chart, all, {}).rows).toEqual([])
  })

  it('books payroll against wages, cash and the statutory payables', () => {
    const paid = tx({ kind: 'cash_out', accountId: 'bank', categoryId: 'cat-payroll', amount: 8_000_000, origin: 'payroll' })
    const line = { bpjsHealth: 50_000, bpjsEmployment: 150_000, companyBpjs: 512_000, pph21: 100_000, loanDeduction: 200_000 }
    const period = { id: 'pay-2026-09', month: '2026-09', transactionId: paid.id, lines: [line, line] } as unknown as PayrollPeriod
    const entry = payrollJournal(period, paid)
    expect(totalDebits(entry.lines)).toBe(totalCredits(entry.lines))
    const of = (id: string) => entry.lines.find((l) => l.accountId === id)
    expect(of(GL.wages)?.debit).toBe(8_000_000 + 400_000 + 200_000 + 400_000)
    expect(of(GL.employerBpjs)?.debit).toBe(1_024_000)
    expect(of(GL.bpjsPayable)?.credit).toBe(400_000 + 1_024_000)
    expect(of(GL.pph21Payable)?.credit).toBe(200_000)
    expect(of(cashGlId('bank'))?.credit).toBe(8_000_000)
    expect(journalFor(paid, books([paid], [period])).source).toBe('payroll')
  })

  it('builds statements that balance, with a running ledger', () => {
    const list = [tx({ amount: 400_000 }), tx({ kind: 'cash_out', categoryId: 'cat-util', amount: 150_000, date: '2026-09-20' }), tx({ amount: 250_000, date: '2026-10-02', villaId: 'vil-b' })]
    const entries = buildJournals({ ...books(list), cashAccounts: accounts, loans: [{ amount: 300_000, repaid: 100_000, status: 'active' }] })
    const tb = trialBalance(chart, entries, { to: '2026-10-31' })
    expect(tb.debit).toBe(tb.credit)
    const september = incomeStatement(chart, entries, { from: '2026-09-01', to: '2026-09-30' })
    expect(september).toMatchObject({ totalRevenue: 400_000, totalExpenses: 150_000, net: 250_000 })
    expect(incomeStatement(chart, entries, { villaId: 'vil-b' }).net).toBe(250_000)
    const bs = balanceSheet(chart, entries, { asOf: '2026-10-31' })
    expect(bs.balanced).toBe(true)
    expect(bs.totalAssets).toBe(6_000_000 + 200_000 + 500_000)
    expect(bs.yearEarnings).toBe(500_000)
    const gl = generalLedger(chart.find((a) => a.id === cashGlId('cb'))!, entries, { from: '2026-09-15' })
    expect(gl.opening).toBe(1_400_000)
    expect(gl.lines.map((l) => l.balance)).toEqual([1_250_000, 1_500_000])
    expect(gl.closing).toBe(1_500_000)
  })

  it('keeps categories off cash accounts and checks manual journals', () => {
    expect(() => validateMapping(cashGlId('cb'), chart)).toThrow(expect.objectContaining({ code: 'LEDGER_ACCOUNT_INVALID' }))
    expect(() => validateMapping('gl-nope', chart)).toThrow(expect.objectContaining({ code: 'LEDGER_ACCOUNT_INVALID' }))
    expect(() => validateMapping(GL.otherIncome, chart)).not.toThrow()
    const lines = [{ accountId: GL.receivable, debit: 100, credit: 0 }, { accountId: GL.roomRevenue, debit: 0, credit: 100 }]
    expect(validateManualJournal({ date: '2026-09-30', villaId: null, memo: 'Accrue a stay', lines, attachments: [] }, chart)).toEqual({})
    expect(validateManualJournal({ date: '', villaId: null, memo: 'x', lines: [lines[0]!], attachments: [] }, chart)).toMatchObject({ date: expect.any(String), memo: expect.any(String), lines: expect.any(String) })
    expect(validateManualJournal({ date: '2026-09-30', villaId: null, memo: 'Move cash', lines: [{ ...lines[0]!, accountId: cashGlId('cb') }, lines[1]!], attachments: [] }, chart).lines).toMatch(/cash entries/)
  })

  it('closes ended months only, with nothing pending, and refuses postings into them', () => {
    const closes = [{ month: '2026-09', closedOn: '2026-10-03', closedBy: 'Ida', note: '' }]
    expect(() => assertOpenPeriod(closes, '2026-09-30')).toThrow(expect.objectContaining({ code: 'PERIOD_CLOSED' }))
    expect(() => assertOpenPeriod(closes, '2026-10-01')).not.toThrow()
    expect(() => assertClosable('2026-10', '2026-10-15', [], [])).toThrow(expect.objectContaining({ code: 'PERIOD_NOT_ENDED' }))
    expect(() => assertClosable('2026-09', '2026-10-15', closes, [])).toThrow(expect.objectContaining({ code: 'PERIOD_CLOSED' }))
    expect(() => assertClosable('2026-08', '2026-10-15', [], [{ status: 'submitted', date: '2026-08-31' }])).toThrow(expect.objectContaining({ code: 'PERIOD_PENDING' }))
    expect(() => assertClosable('2026-08', '2026-10-15', [], [{ status: 'posted', date: '2026-08-31' }])).not.toThrow()
    expect(monthsSince('2026-08-20', '2026-10-02')).toEqual(['2026-08', '2026-09', '2026-10'])
  })
})
