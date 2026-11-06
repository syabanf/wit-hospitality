import { addMonths, withinRange, type IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'
import { RuleError } from './errors'
import { awaitsApproval, counts, type ApprovalGrant, type CashAccount, type Category, type Transaction, type TransactionEvent, type TransactionOrigin, type TransactionStatus } from './finance'
import type { Loan } from './hr'
import { periodLabel, type PayrollPeriod } from './payroll'

/**
 * Double-entry books behind the cash ledger. Staff keep recording cash entries; every posted
 * entry writes a balanced journal entry, so the trial balance, income statement and balance
 * sheet come out of the same records. Journals are written once and never edited.
 */
export type GlType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'
export const GL_TYPES: readonly GlType[] = ['asset', 'liability', 'equity', 'revenue', 'expense']
export const GL_TYPE_LABEL: Record<GlType, string> = { asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Revenue', expense: 'Expense' }
export type NormalSide = 'debit' | 'credit'
export const normalSide = (type: GlType): NormalSide => (type === 'asset' || type === 'expense' ? 'debit' : 'credit')

export interface GlAccount {
  id: string
  code: string
  name: string
  type: GlType
  normal: NormalSide
  /** Set on the GL account that mirrors one cashbox, bank or petty cash account. */
  cashAccountId: string | null
}

const gl = (id: string, code: string, name: string, type: GlType): GlAccount => ({ id, code, name, type, normal: normalSide(type), cashAccountId: null })

export const GL = {
  transit: 'gl-1090',
  receivable: 'gl-1200',
  employeeLoans: 'gl-1300',
  deposits: 'gl-2100',
  partnerPayable: 'gl-2200',
  payrollPayable: 'gl-2300',
  bpjsPayable: 'gl-2310',
  pph21Payable: 'gl-2320',
  ownerEquity: 'gl-3000',
  retained: 'gl-3100',
  roomRevenue: 'gl-4100',
  roomService: 'gl-4200',
  otherIncome: 'gl-4900',
  partnerCost: 'gl-5100',
  wages: 'gl-6100',
  employerBpjs: 'gl-6110',
  variance: 'gl-6900',
  otherExpense: 'gl-6990',
} as const

/** The hospitality chart besides the cash accounts, which `chartOfAccounts` adds from the cash ledger. */
export const BASE_CHART: readonly GlAccount[] = [
  gl(GL.transit, '1090', 'Cash in transit', 'asset'),
  gl(GL.receivable, '1200', 'Accounts receivable, guests', 'asset'),
  gl(GL.employeeLoans, '1300', 'Employee loans and advances', 'asset'),
  gl(GL.deposits, '2100', 'Guest deposits received in advance', 'liability'),
  gl(GL.partnerPayable, '2200', 'Payables to service partners', 'liability'),
  gl(GL.payrollPayable, '2300', 'Payroll payable', 'liability'),
  gl(GL.bpjsPayable, '2310', 'BPJS payable', 'liability'),
  gl(GL.pph21Payable, '2320', 'PPh 21 payable', 'liability'),
  gl(GL.ownerEquity, '3000', 'Owner equity', 'equity'),
  gl(GL.retained, '3100', 'Retained earnings', 'equity'),
  gl(GL.roomRevenue, '4100', 'Room revenue', 'revenue'),
  gl(GL.roomService, '4200', 'Room service revenue', 'revenue'),
  gl(GL.otherIncome, '4900', 'Other income', 'revenue'),
  gl(GL.partnerCost, '5100', 'Service partner costs', 'expense'),
  gl(GL.wages, '6100', 'Salaries and wages', 'expense'),
  gl(GL.employerBpjs, '6110', 'Employer BPJS', 'expense'),
  gl('gl-6200', '6200', 'Utilities', 'expense'),
  gl('gl-6300', '6300', 'Housekeeping supplies', 'expense'),
  gl('gl-6400', '6400', 'Maintenance and repairs', 'expense'),
  gl('gl-6500', '6500', 'Staff and transport', 'expense'),
  gl('gl-6600', '6600', 'Marketing', 'expense'),
  gl('gl-6700', '6700', 'Payment and bank fees', 'expense'),
  gl('gl-6800', '6800', 'Guest activities', 'expense'),
  gl(GL.variance, '6900', 'Cash over and short', 'expense'),
  gl(GL.otherExpense, '6990', 'Other expenses', 'expense'),
]

export const cashGlId = (cashAccountId: string) => `gl-cash-${cashAccountId}`

/** One cash GL account per cash account, coded 1001 upward in the order they were opened, then the base chart. */
export function chartOfAccounts(cashAccounts: readonly CashAccount[]): GlAccount[] {
  const cash = cashAccounts.map((a, i) => ({ ...gl(cashGlId(a.id), String(1001 + i), a.name, 'asset'), cashAccountId: a.id }))
  return [...cash, ...BASE_CHART].sort((a, b) => a.code.localeCompare(b.code))
}

/** Where each finance category books by default; finance edits this on the Categories page. */
export const DEFAULT_CATEGORY_ACCOUNTS: Readonly<Record<string, string>> = {
  'cat-room': GL.roomRevenue,
  'cat-airbnb': GL.roomRevenue,
  'cat-extra': GL.otherIncome,
  'cat-deposit': GL.deposits,
  'cat-transfer-in': GL.transit,
  'cat-transfer-out': GL.transit,
  'cat-adjust-in': GL.variance,
  'cat-adjust-out': GL.variance,
  'cat-util': 'gl-6200',
  'cat-house': 'gl-6300',
  'cat-maint': 'gl-6400',
  'cat-pool': 'gl-6400',
  'cat-staff': 'gl-6500',
  'cat-mkt': 'gl-6600',
  'cat-payroll': GL.wages,
  'cat-other': GL.otherExpense,
  'cat-fees': 'gl-6700',
  'cat-boat': 'gl-6800',
  'cat-svc-fnb': GL.roomService,
  'cat-svc-laundry': GL.roomService,
  'cat-svc-transport': GL.roomService,
  'cat-svc-spa': GL.roomService,
  'cat-svc-tours': GL.roomService,
  'cat-svc-other': GL.roomService,
  'cat-svc-partner': GL.partnerCost,
}

/** The GL account a category books to; a category without a mapping falls to other income or other expenses. */
export const categoryAccount = (map: Readonly<Record<string, string>>, category: Pick<Category, 'id' | 'kind'>) => map[category.id] ?? (category.kind === 'cash_in' ? GL.otherIncome : GL.otherExpense)

/** A category maps to any account in the chart except a cash account: cash moves through the cash ledger. */
export function validateMapping(accountId: string, chart: readonly GlAccount[]) {
  const account = chart.find((a) => a.id === accountId)
  if (!account) throw new RuleError('LEDGER_ACCOUNT_INVALID', 'Pick an account from the chart.')
  if (account.cashAccountId) throw new RuleError('LEDGER_ACCOUNT_INVALID', `${account.name} is a cash account; a category books against the cash account, not into it.`)
}

export interface JournalLine {
  accountId: string
  debit: number
  credit: number
}

export type JournalSource = 'opening' | 'transaction' | 'transfer' | 'payroll' | 'manual'
export const JOURNAL_SOURCE_LABEL: Record<JournalSource, string> = { opening: 'Opening balance', transaction: 'Cash entry', transfer: 'Cash transfer', payroll: 'Payroll', manual: 'Manual journal' }

export interface JournalEntry {
  id: string
  number: string
  date: IsoDate
  villaId: string | null
  memo: string
  source: JournalSource
  /** The record that wrote the entry: a transaction, a payroll period or a manual journal. */
  sourceId: string
  sourceNumber: string
  /** The cash entry's origin, for transaction and transfer entries. */
  origin: TransactionOrigin | null
  lines: readonly JournalLine[]
  postedOn: IsoDate
  postedBy: string
}

/** An entry before it gets its number. */
export type JournalDraft = Omit<JournalEntry, 'id' | 'number' | 'postedOn' | 'postedBy'>

const debit = (accountId: string, amount: number): JournalLine => ({ accountId, debit: amount, credit: 0 })
const credit = (accountId: string, amount: number): JournalLine => ({ accountId, debit: 0, credit: amount })
export const totalDebits = (lines: readonly JournalLine[]) => lines.reduce((s, l) => s + l.debit, 0)
export const totalCredits = (lines: readonly JournalLine[]) => lines.reduce((s, l) => s + l.credit, 0)

/** The double-entry invariant: whole rupiah, one side per line, debits equal credits. */
export function assertBalanced(lines: readonly JournalLine[]) {
  if (lines.length < 2) throw new RuleError('JOURNAL_UNBALANCED', 'A journal entry needs at least two lines.')
  for (const l of lines) {
    if (!Number.isInteger(l.debit) || !Number.isInteger(l.credit) || l.debit < 0 || l.credit < 0) throw new RuleError('JOURNAL_UNBALANCED', 'Journal amounts are whole rupiah, zero or more.')
    if ((l.debit > 0) === (l.credit > 0)) throw new RuleError('JOURNAL_UNBALANCED', 'Each journal line is either a debit or a credit.')
  }
  const dr = totalDebits(lines)
  const cr = totalCredits(lines)
  if (dr !== cr) throw new RuleError('JOURNAL_UNBALANCED', `Debits of ${dr} and credits of ${cr} differ by ${Math.abs(dr - cr)}.`)
}

/** Drops zero lines and checks the rest balance. */
function balanced(draft: JournalDraft): JournalDraft {
  const lines = draft.lines.filter((l) => l.debit > 0 || l.credit > 0)
  assertBalanced(lines)
  return { ...draft, lines }
}

const fromTransaction = (t: Transaction, source: JournalSource, lines: JournalLine[]): JournalDraft =>
  balanced({ date: t.date, villaId: t.villaId, memo: t.description, source, sourceId: t.id, sourceNumber: t.number, origin: t.origin, lines })

/** Cash in debits the cash account and credits the category's account; cash out the other way round. */
function transactionJournal(t: Transaction, map: Readonly<Record<string, string>>, categories: readonly Category[]): JournalDraft {
  const cash = cashGlId(t.accountId)
  const other = categoryAccount(map, categories.find((c) => c.id === t.categoryId) ?? { id: t.categoryId, kind: t.kind })
  return fromTransaction(t, 'transaction', t.kind === 'cash_in' ? [debit(cash, t.amount), credit(other, t.amount)] : [debit(other, t.amount), credit(cash, t.amount)])
}

/** Both halves of a transfer as one entry: the receiving account debited, the sending one credited. */
function transferJournal(out: Transaction, into: Transaction): JournalDraft {
  return { ...fromTransaction(out, 'transfer', [debit(cashGlId(into.accountId), into.amount), credit(cashGlId(out.accountId), out.amount)]), memo: `${out.description} (${out.number} and ${into.number})` }
}

/**
 * A closed payroll: the salary cost against the cash paid and what was withheld. Wages are the
 * bank payment plus employee BPJS, PPh 21 and loan instalments; company BPJS is its own cost.
 */
export function payrollJournal(p: PayrollPeriod, paid: Transaction): JournalDraft {
  const sum = (pick: (l: PayrollPeriod['lines'][number]) => number) => p.lines.reduce((s, l) => s + pick(l), 0)
  const employeeBpjs = sum((l) => l.bpjsHealth + l.bpjsEmployment)
  const companyBpjs = sum((l) => l.companyBpjs)
  const tax = sum((l) => l.pph21)
  const loans = sum((l) => l.loanDeduction)
  return {
    ...fromTransaction(paid, 'payroll', [
      debit(GL.wages, paid.amount + employeeBpjs + tax + loans),
      debit(GL.employerBpjs, companyBpjs),
      credit(cashGlId(paid.accountId), paid.amount),
      credit(GL.bpjsPayable, employeeBpjs + companyBpjs),
      credit(GL.pph21Payable, tax),
      credit(GL.employeeLoans, loans),
    ]),
    memo: `Payroll ${periodLabel(p.month)}: salaries paid with ${paid.number}`,
    sourceId: p.id,
    sourceNumber: `PAY-${p.month}`,
  }
}

/**
 * The cash accounts' opening balances against owner equity, one entry per opening date. The first
 * one also carries employee loans already lent out, since loans pay out outside the cash ledger.
 */
export function openingJournals(accounts: readonly CashAccount[], employeeLoans = 0): JournalDraft[] {
  const dates = [...new Set(accounts.filter((a) => a.openingBalance > 0).map((a) => a.openedOn))].sort()
  return dates.map((date, i) => {
    const opened = accounts.filter((a) => a.openedOn === date && a.openingBalance > 0)
    const loans = i === 0 ? employeeLoans : 0
    const total = opened.reduce((s, a) => s + a.openingBalance, loans)
    return balanced({ date, villaId: null, memo: `Opening balances of ${opened.map((a) => a.name).join(', ')}${loans ? ' and employee loans' : ''}`, source: 'opening', sourceId: `opening-${date}`, sourceNumber: 'Opening', origin: null, lines: [...opened.map((a) => debit(cashGlId(a.id), a.openingBalance)), debit(GL.employeeLoans, loans), credit(GL.ownerEquity, total)] })
  })
}

/** What the journal builders read besides the entry itself. */
export interface Books {
  transactions: readonly Transaction[]
  periods: readonly PayrollPeriod[]
  /** Category id to GL account id. */
  map: Readonly<Record<string, string>>
  categories: readonly Category[]
}

/** What one posted cash entry writes: one entry for both halves of a transfer, the payroll entry for a salary payment. */
export function journalFor(t: Transaction, books: Books): JournalDraft {
  const twin = t.transferId ? books.transactions.find((o) => o.transferId === t.transferId && o.id !== t.id && counts(o)) : undefined
  if (twin) return t.kind === 'cash_out' ? transferJournal(t, twin) : transferJournal(twin, t)
  const period = t.origin === 'payroll' ? books.periods.find((p) => p.transactionId === t.id) : undefined
  if (period) return payrollJournal(period, t)
  return transactionJournal(t, books.map, books.categories)
}

/** Numbers the drafts in date order; the seed and the books check build the whole journal this way. */
export function buildJournals(books: Books & { cashAccounts: readonly CashAccount[]; loans: ReadonlyArray<Pick<Loan, 'amount' | 'repaid' | 'status'>> }, postedBy = 'System'): JournalEntry[] {
  const posted = books.transactions.filter(counts).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
  const fromCash = posted.map((t) => journalFor(t, books)).filter((d, i, all) => all.findIndex((o) => o.source === d.source && o.sourceId === d.sourceId) === i)
  // Lent at the start: what is still owed plus the instalments the posted payrolls take back.
  const owed = books.loans.filter((l) => l.status === 'active').reduce((s, l) => s + l.amount - l.repaid, 0)
  const repaid = fromCash.flatMap((d) => d.lines).filter((l) => l.accountId === GL.employeeLoans).reduce((s, l) => s + l.credit, 0)
  return [...openingJournals(books.cashAccounts, owed + repaid), ...fromCash].sort((a, b) => a.date.localeCompare(b.date)).map((d, i) => numbered(d, i + 1, d.date, postedBy))
}

export const numbered = (d: JournalDraft, n: number, postedOn: IsoDate, postedBy: string): JournalEntry => ({ ...d, id: `je-${n}`, number: `JE-${String(n).padStart(5, '0')}`, postedOn, postedBy })

/** An adjusting entry finance writes by hand; it signs through the approval chain like a cash-out of its total. */
export interface ManualJournalInput {
  date: string
  villaId: string | null
  memo: string
  lines: readonly JournalLine[]
  attachments: readonly Attachment[]
}

export interface ManualJournal extends ManualJournalInput {
  id: string
  number: string
  status: TransactionStatus
  approvals: readonly ApprovalGrant[]
  history: readonly TransactionEvent[]
  rejectionReason: string | null
  /** The journal entry written when it posts. */
  journalId: string | null
  createdBy: string
  createdById: string
  createdOn: IsoDate
}

export function validateManualJournal(input: ManualJournalInput, chart: readonly GlAccount[]): Partial<Record<'date' | 'memo' | 'lines', string>> {
  const errors: Partial<Record<'date' | 'memo' | 'lines', string>> = {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) errors.date = 'Pick the date.'
  if (input.memo.trim().length < 5) errors.memo = 'Say what the journal corrects.'
  const used = input.lines.filter((l) => l.accountId || l.debit || l.credit)
  if (used.length < 2) errors.lines = 'Enter at least two lines.'
  else if (used.some((l) => !chart.some((a) => a.id === l.accountId))) errors.lines = 'Pick an account on every line.'
  else if (used.some((l) => chart.find((a) => a.id === l.accountId)?.cashAccountId)) errors.lines = 'Cash and bank move through cash entries; use a cash entry or a balance adjustment.'
  return errors
}

/** A posted manual journal as its journal entry. */
export const manualJournalEntry = (m: ManualJournal): JournalDraft => balanced({ date: m.date, villaId: m.villaId, memo: m.memo, source: 'manual', sourceId: m.id, sourceNumber: m.number, origin: null, lines: m.lines })

/** A month finance has closed: nothing posts into it until someone reopens it. */
export interface PeriodClose {
  /** "YYYY-MM". */
  month: string
  closedOn: IsoDate
  closedBy: string
  note: string
}

export const monthOf = (date: IsoDate) => date.slice(0, 7)

export function assertOpenPeriod(closes: readonly PeriodClose[], date: IsoDate) {
  const month = monthOf(date)
  if (closes.some((c) => c.month === month)) throw new RuleError('PERIOD_CLOSED', `${periodLabel(month)} is closed; reopen it before posting into it.`)
}

/** A month closes once it has ended and nothing dated in it still waits for approval. */
export function assertClosable(month: string, today: IsoDate, closes: readonly PeriodClose[], pending: ReadonlyArray<Pick<Transaction, 'status' | 'date'>>) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RuleError('VALIDATION_ERROR', 'Pick a month as YYYY-MM.')
  if (month >= monthOf(today)) throw new RuleError('PERIOD_NOT_ENDED', `${periodLabel(month)} has not ended yet.`)
  if (closes.some((c) => c.month === month)) throw new RuleError('PERIOD_CLOSED', `${periodLabel(month)} is already closed.`)
  const waiting = pending.filter((t) => awaitsApproval(t) && monthOf(t.date) === month).length
  if (waiting) throw new RuleError('PERIOD_PENDING', `${waiting} ${waiting === 1 ? 'entry' : 'entries'} dated in ${periodLabel(month)} still ${waiting === 1 ? 'waits' : 'wait'} for approval or posting.`)
}

/** Every month from the first entry's month up to and including `today`'s. */
export function monthsSince(first: IsoDate, today: IsoDate): string[] {
  const out: string[] = []
  for (let d = `${monthOf(first)}-01`; monthOf(d) <= monthOf(today); d = addMonths(d, 1)) out.push(monthOf(d))
  return out
}

export interface EntryFilter {
  from?: IsoDate
  to?: IsoDate
  villaId?: string
}

export const filterEntries = (entries: readonly JournalEntry[], f: EntryFilter) => entries.filter((e) => withinRange(e.date, f.from, f.to) && (!f.villaId || e.villaId === f.villaId))

/** Debits less credits per account. */
function movements(entries: readonly JournalEntry[]): Map<string, { debit: number; credit: number }> {
  const out = new Map<string, { debit: number; credit: number }>()
  for (const e of entries)
    for (const l of e.lines) {
      const m = out.get(l.accountId) ?? { debit: 0, credit: 0 }
      m.debit += l.debit
      m.credit += l.credit
      out.set(l.accountId, m)
    }
  return out
}

/** A balance on the account's normal side: positive is the usual state. */
const natural = (a: GlAccount, m: { debit: number; credit: number } | undefined) => (m ? (a.normal === 'debit' ? m.debit - m.credit : m.credit - m.debit) : 0)

export interface TrialBalanceRow {
  account: GlAccount
  debit: number
  credit: number
}

/** Each account's closing balance in the debit or the credit column; the two columns always agree. */
export function trialBalance(chart: readonly GlAccount[], entries: readonly JournalEntry[], f: EntryFilter): { rows: TrialBalanceRow[]; debit: number; credit: number } {
  const m = movements(filterEntries(entries, { to: f.to, villaId: f.villaId }))
  const rows = chart
    .map((account) => {
      const net = (m.get(account.id)?.debit ?? 0) - (m.get(account.id)?.credit ?? 0)
      return { account, debit: Math.max(0, net), credit: Math.max(0, -net) }
    })
    .filter((r) => r.debit || r.credit)
  return { rows, debit: rows.reduce((s, r) => s + r.debit, 0), credit: rows.reduce((s, r) => s + r.credit, 0) }
}

export interface LedgerLine {
  entry: JournalEntry
  debit: number
  credit: number
  balance: number
}

/** One account's lines in the range with a running balance on its normal side. */
export function generalLedger(account: GlAccount, entries: readonly JournalEntry[], f: EntryFilter): { opening: number; lines: LedgerLine[]; closing: number } {
  const scoped = filterEntries(entries, { villaId: f.villaId })
  const before = f.from ? scoped.filter((e) => e.date < (f.from as string)) : []
  const opening = natural(account, movements(before).get(account.id))
  let running = opening
  const lines: LedgerLine[] = []
  for (const entry of filterEntries(scoped, { from: f.from, to: f.to }).sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number)))
    for (const l of entry.lines) {
      if (l.accountId !== account.id) continue
      running += account.normal === 'debit' ? l.debit - l.credit : l.credit - l.debit
      lines.push({ entry, debit: l.debit, credit: l.credit, balance: running })
    }
  return { opening, lines, closing: running }
}

export interface StatementLine {
  account: GlAccount
  amount: number
}

const linesOf = (chart: readonly GlAccount[], m: ReturnType<typeof movements>, type: GlType) =>
  chart
    .filter((a) => a.type === type)
    .map((account) => ({ account, amount: natural(account, m.get(account.id)) }))
    .filter((l) => l.amount !== 0)
const total = (lines: readonly StatementLine[]) => lines.reduce((s, l) => s + l.amount, 0)

/** Revenue less expenses in the range. */
export function incomeStatement(chart: readonly GlAccount[], entries: readonly JournalEntry[], f: EntryFilter) {
  const m = movements(filterEntries(entries, f))
  const revenue = linesOf(chart, m, 'revenue')
  const expenses = linesOf(chart, m, 'expense')
  return { revenue, expenses, totalRevenue: total(revenue), totalExpenses: total(expenses), net: total(revenue) - total(expenses) }
}

/**
 * Assets against liabilities and equity on `asOf`. Revenue and expense accounts are never closed
 * into retained earnings by hand: earnings before the year start join retained earnings, and this
 * year's show as their own equity line, so the sheet balances on any date.
 */
export function balanceSheet(chart: readonly GlAccount[], entries: readonly JournalEntry[], f: { asOf: IsoDate; villaId?: string }) {
  const scoped = filterEntries(entries, { to: f.asOf, villaId: f.villaId })
  const yearStart = `${f.asOf.slice(0, 4)}-01-01`
  const m = movements(scoped)
  const earned = (list: readonly JournalEntry[]) => incomeStatement(chart, list, {}).net
  const priorEarnings = earned(scoped.filter((e) => e.date < yearStart))
  const yearEarnings = earned(scoped.filter((e) => e.date >= yearStart))
  const assets = linesOf(chart, m, 'asset')
  const liabilities = linesOf(chart, m, 'liability')
  const equity = linesOf(chart, m, 'equity').filter((l) => l.account.id !== GL.retained)
  const retained = chart.find((a) => a.id === GL.retained)
  const retainedTotal = retained ? natural(retained, m.get(retained.id)) + priorEarnings : 0
  if (retained && retainedTotal) equity.push({ account: retained, amount: retainedTotal })
  const totalAssets = total(assets)
  const totalLiabilities = total(liabilities)
  const totalEquity = total(equity) + yearEarnings
  return { assets, liabilities, equity, yearEarnings, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity }
}
