import { withinRange, type IsoDate } from '@/lib/dates'

export type TransactionKind = 'cash_in' | 'cash_out'
export const KIND_LABEL: Record<TransactionKind, string> = { cash_in: 'Cash in', cash_out: 'Cash out' }

export type TransactionStatus = 'draft' | 'submitted' | 'approved' | 'posted' | 'reversed'
export const TRANSACTION_STATUSES: readonly TransactionStatus[] = ['draft', 'submitted', 'approved', 'posted', 'reversed']
export const TRANSACTION_STATUS_LABEL: Record<TransactionStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  posted: 'Posted',
  reversed: 'Reversed',
}

export type AccountKind = 'cashbox' | 'bank'

export interface CashAccount {
  id: string
  name: string
  kind: AccountKind
  /** Cashboxes sit at one location; the bank account serves all of them. */
  locationId: string | null
  openingBalance: number
  openedOn: IsoDate
}

export interface CashAccountInput {
  name: string
  kind: AccountKind
  locationId: string | null
  openingBalance: number
  openedOn: string
}

export function validateAccount(input: CashAccountInput, accounts: readonly CashAccount[], excludeId?: string): Partial<Record<keyof CashAccountInput, string>> {
  const errors: Partial<Record<keyof CashAccountInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the account name.'
  else if (accounts.some((a) => a.name.toLowerCase() === input.name.trim().toLowerCase() && a.id !== excludeId)) errors.name = `${input.name.trim()} already exists.`
  if (input.kind === 'cashbox' && !input.locationId) errors.locationId = 'A cashbox sits at one location.'
  if (!Number.isInteger(input.openingBalance) || input.openingBalance < 0) errors.openingBalance = 'Enter the opening balance in whole rupiah, zero or more.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.openedOn)) errors.openedOn = 'Pick the opening date.'
  return errors
}

export interface Category {
  id: string
  name: string
  kind: TransactionKind
  /** Chart slot inside its kind; 0 folds into Other. */
  slot: number
  active: boolean
}

export interface Transaction {
  id: string
  number: string
  accountId: string
  kind: TransactionKind
  categoryId: string
  amount: number
  date: IsoDate
  locationId: string
  villaId: string | null
  unitId: string | null
  bookingId: string | null
  description: string
  status: TransactionStatus
  /** Set on a reversal: the posted transaction it cancels. */
  reversalOf: string | null
  /** Set on a reversed transaction: the reversal that cancelled it. */
  reversedBy: string | null
  createdBy: string
  createdOn: IsoDate
}

export const TRANSACTION_TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  draft: ['submitted'],
  submitted: ['approved'],
  approved: ['posted'],
  posted: [],
  reversed: [],
}

export const canTransitionTransaction = (t: Pick<Transaction, 'status'>, to: TransactionStatus) => TRANSACTION_TRANSITIONS[t.status].includes(to)
export const nextTransactionStep = (t: Pick<Transaction, 'status'>) => TRANSACTION_TRANSITIONS[t.status][0] ?? null
export const TRANSACTION_ACTION_LABEL: Record<Exclude<TransactionStatus, 'draft'>, string> = {
  submitted: 'Submit for approval',
  approved: 'Approve',
  posted: 'Post',
  reversed: 'Reverse',
}

/** Only posted money moves the balance; a reversal is itself posted with the opposite kind. */
export const signed = (t: Pick<Transaction, 'kind' | 'amount'>) => (t.kind === 'cash_in' ? t.amount : -t.amount)
export const counts = (t: Pick<Transaction, 'status'>) => t.status === 'posted' || t.status === 'reversed'

export function balance(account: CashAccount, transactions: readonly Transaction[], upTo?: IsoDate): number {
  return transactions
    .filter((t) => t.accountId === account.id && counts(t) && (!upTo || t.date <= upTo))
    .reduce((s, t) => s + signed(t), account.openingBalance)
}

export interface CashSummary {
  cashIn: number
  cashOut: number
  net: number
}

/** Posted money inside [from, to). Reversed pairs cancel out. */
export function cashSummary(transactions: readonly Transaction[], from: IsoDate, to: IsoDate): CashSummary {
  const inRange = transactions.filter((t) => counts(t) && from <= t.date && t.date < to)
  const cashIn = inRange.filter((t) => t.kind === 'cash_in').reduce((s, t) => s + t.amount, 0)
  const cashOut = inRange.filter((t) => t.kind === 'cash_out').reduce((s, t) => s + t.amount, 0)
  return { cashIn, cashOut, net: cashIn - cashOut }
}

export interface CategorySlice {
  id: string
  label: string
  value: number
  slot: number
}

/** Posted totals per category of one kind, catalog order, slot 0 folded into Other, zero rows dropped. */
export function byCategory(transactions: readonly Transaction[], categories: readonly Category[], kind: TransactionKind, from: IsoDate, to: IsoDate): CategorySlice[] {
  const live = transactions.filter((t) => t.kind === kind && counts(t) && from <= t.date && t.date < to && !t.reversalOf && !t.reversedBy)
  const rows = categories
    .filter((c) => c.kind === kind)
    .map((c) => ({ id: c.id, label: c.name, value: live.filter((t) => t.categoryId === c.id).reduce((s, t) => s + t.amount, 0), slot: c.slot }))
    .filter((r) => r.value > 0)
  const named = rows.filter((r) => r.slot > 0)
  const other = rows.filter((r) => r.slot === 0).reduce((s, r) => s + r.value, 0)
  return other > 0 ? [...named, { id: 'other', label: 'Other', value: other, slot: 0 }] : named
}

export interface TransactionInput {
  accountId: string
  kind: TransactionKind
  categoryId: string
  amount: number
  date: string
  locationId: string
  villaId: string | null
  unitId: string | null
  bookingId: string | null
  description: string
}

export function validateTransaction(input: TransactionInput, categories: readonly Category[]): Partial<Record<keyof TransactionInput, string>> {
  const errors: Partial<Record<keyof TransactionInput, string>> = {}
  if (!input.accountId) errors.accountId = 'Pick the account the money moves through.'
  const category = categories.find((c) => c.id === input.categoryId)
  if (!category) errors.categoryId = 'Pick a category.'
  else if (category.kind !== input.kind) errors.categoryId = `${category.name} is a ${KIND_LABEL[category.kind].toLowerCase()} category.`
  else if (!category.active) errors.categoryId = `${category.name} is archived.`
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter a whole rupiah amount above zero.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) errors.date = 'Pick the date.'
  if (!input.locationId) errors.locationId = 'Map the money to a location.'
  if (input.description.trim().length < 3) errors.description = 'Say what the money was for.'
  return errors
}

export interface TransactionFilter {
  status?: TransactionStatus | 'all'
  kind?: TransactionKind | 'all'
  categoryId?: string
  accountId?: string
  query?: string
  from?: string
  to?: string
}

export function filterTransactions<T extends Transaction & { categoryName: string; accountName: string }>(list: readonly T[], f: TransactionFilter): T[] {
  const q = (f.query ?? '').trim().toLowerCase()
  return list.filter((t) => {
    if (f.status && f.status !== 'all' && t.status !== f.status) return false
    if (f.kind && f.kind !== 'all' && t.kind !== f.kind) return false
    if (f.categoryId && t.categoryId !== f.categoryId) return false
    if (f.accountId && t.accountId !== f.accountId) return false
    if (!withinRange(t.date, f.from, f.to)) return false
    if (q && ![t.number, t.description, t.categoryName, t.accountName].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

/** Draft, Submitted, Approved, Posted; a reversed record ends in a fifth step. */
export function transactionSteps(t: Transaction, fmt: (iso: IsoDate) => string) {
  const order: TransactionStatus[] = ['draft', 'submitted', 'approved', 'posted']
  const at = t.status === 'reversed' ? 4 : order.indexOf(t.status)
  const steps = order.map((s, i) => ({
    id: s,
    label: TRANSACTION_STATUS_LABEL[s],
    hint: s === 'draft' ? fmt(t.createdOn) : undefined,
    state: (i < at ? 'done' : i === at ? 'current' : 'upcoming') as 'done' | 'current' | 'upcoming',
  }))
  if (t.status === 'reversed') steps.push({ id: 'reversed', label: 'Reversed', hint: undefined, state: 'current' })
  return steps
}
