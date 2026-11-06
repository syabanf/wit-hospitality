import { withinRange, type IsoDate } from '@/lib/dates'
import type { Role } from './access'
import type { Attachment } from './attachment'

export type TransactionKind = 'cash_in' | 'cash_out'
export const KIND_LABEL: Record<TransactionKind, string> = { cash_in: 'Cash in', cash_out: 'Cash out' }

export type TransactionStatus = 'draft' | 'submitted' | 'approved' | 'posted' | 'rejected' | 'reversed'
export const TRANSACTION_STATUSES: readonly TransactionStatus[] = ['draft', 'submitted', 'approved', 'posted', 'rejected', 'reversed']
export const TRANSACTION_STATUS_LABEL: Record<TransactionStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  posted: 'Posted',
  rejected: 'Rejected',
  reversed: 'Reversed',
}

/** How an entry came to exist; transfers, adjustments and reconciliations are system-shaped. */
export type TransactionOrigin = 'manual' | 'front_desk' | 'transfer' | 'adjustment' | 'reconciliation' | 'payroll' | 'reversal' | 'payment' | 'maintenance' | 'room_service' | 'stock'
export const ORIGIN_LABEL: Record<TransactionOrigin, string> = {
  manual: 'Manual entry',
  front_desk: 'Front desk',
  transfer: 'Cash transfer',
  adjustment: 'Adjustment',
  reconciliation: 'Reconciliation',
  payroll: 'Payroll',
  reversal: 'Reversal',
  payment: 'Guest payment',
  maintenance: 'Maintenance expense',
  room_service: 'Room service',
  stock: 'Stock purchase',
}

export type AccountKind = 'cashbox' | 'bank' | 'petty'
export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = { cashbox: 'Cashbox', bank: 'Bank', petty: 'Petty cash' }

export interface CashAccount {
  id: string
  name: string
  kind: AccountKind
  /** Cashboxes and petty cash sit at one location; the bank account serves all of them. */
  locationId: string | null
  /** Petty cash belongs to one villa; null for the other kinds. */
  villaId: string | null
  /** The petty cash float: top-ups bring the box back to this. */
  floatLimit: number | null
  /** The employee who holds the petty cash. */
  custodianId: string | null
  openingBalance: number
  openedOn: IsoDate
}

export interface CashAccountInput {
  name: string
  kind: AccountKind
  locationId: string | null
  villaId: string | null
  floatLimit: number | null
  custodianId: string | null
  openingBalance: number
  openedOn: string
}

/** Petty cash below this share of its float shows as low. */
const PETTY_LOW_SHARE = 0.25
export const pettyLow = (account: Pick<CashAccount, 'kind' | 'floatLimit'>, balance: number) => account.kind === 'petty' && account.floatLimit !== null && balance < account.floatLimit * PETTY_LOW_SHARE
/** What a top-up needs to bring petty cash back to its float. */
export const pettyTopUp = (account: Pick<CashAccount, 'floatLimit'>, balance: number) => Math.max(0, (account.floatLimit ?? 0) - balance)

export function validateAccount(input: CashAccountInput, accounts: readonly CashAccount[], excludeId?: string): Partial<Record<keyof CashAccountInput, string>> {
  const errors: Partial<Record<keyof CashAccountInput, string>> = {}
  if (input.name.trim().length < 2) errors.name = 'Enter the account name.'
  else if (accounts.some((a) => a.name.toLowerCase() === input.name.trim().toLowerCase() && a.id !== excludeId)) errors.name = `${input.name.trim()} already exists.`
  if (input.kind === 'cashbox' && !input.locationId) errors.locationId = 'A cashbox sits at one location.'
  if (input.kind === 'petty') {
    if (!input.villaId) errors.villaId = 'Petty cash belongs to one villa.'
    else if (accounts.some((a) => a.kind === 'petty' && a.villaId === input.villaId && a.id !== excludeId)) errors.villaId = 'That villa already has petty cash.'
    if (!Number.isInteger(input.floatLimit) || (input.floatLimit ?? 0) <= 0) errors.floatLimit = 'Enter the float in whole rupiah.'
    if (!input.custodianId) errors.custodianId = 'Pick who holds the cash.'
  }
  if (!Number.isInteger(input.openingBalance) || input.openingBalance < 0) errors.openingBalance = 'Enter the opening balance in whole rupiah, zero or more.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.openedOn)) errors.openedOn = 'Pick the opening date.'
  return errors
}

/** Categories the console books into on its own; they stay active and keep their kind. */
export const SYSTEM_CATEGORY_IDS: ReadonlySet<string> = new Set(['cat-transfer-in', 'cat-transfer-out', 'cat-adjust-in', 'cat-adjust-out', 'cat-payroll', 'cat-deposit', 'cat-extra', 'cat-fees', 'cat-svc-fnb', 'cat-svc-laundry', 'cat-svc-transport', 'cat-svc-spa', 'cat-svc-tours', 'cat-svc-other', 'cat-svc-partner', 'cat-bpjs', 'cat-pph21'])
export const isSystemCategory = (id: string) => SYSTEM_CATEGORY_IDS.has(id)

export interface Category {
  id: string
  name: string
  kind: TransactionKind
  /** Chart slot inside its kind; 0 folds into Other. */
  slot: number
  active: boolean
  /** Villas the category is enabled for; empty means every villa. */
  villaIds: readonly string[]
}

/** One signature on the approval chain. */
export interface ApprovalGrant {
  level: number
  role: Role
  by: string
  on: IsoDate
  note: string
}

export type TransactionEventKind = 'created' | 'submitted' | 'approved' | 'rejected' | 'resubmitted' | 'posted' | 'reversed'
export const TRANSACTION_EVENT_LABEL: Record<TransactionEventKind, string> = {
  created: 'Created',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  resubmitted: 'Resubmitted',
  posted: 'Posted',
  reversed: 'Reversed',
}

/** The approval history: every submit, approve, reject and post with who and why. */
export interface TransactionEvent {
  kind: TransactionEventKind
  by: string
  role: Role
  on: IsoDate
  note: string
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
  /** External reference: invoice, receipt or bank reference number. */
  reference: string
  /** Receipts and evidence; fixed once the entry is posted. */
  attachments: readonly Attachment[]
  origin: TransactionOrigin
  status: TransactionStatus
  approvals: readonly ApprovalGrant[]
  history: readonly TransactionEvent[]
  rejectionReason: string | null
  /** Set on both halves of a cash transfer. */
  transferId: string | null
  /** Set on a reversal: the posted transaction it cancels. */
  reversalOf: string | null
  /** Set on a reversed transaction: the reversal that cancelled it. */
  reversedBy: string | null
  /** The cashier shift open on the cashbox when the desk recorded it; null keeps an entry off every shift. */
  shiftId?: string | null
  createdBy: string
  createdById: string
  createdOn: IsoDate
}

export const TRANSACTION_TRANSITIONS: Record<TransactionStatus, readonly TransactionStatus[]> = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  rejected: ['submitted'],
  approved: ['posted'],
  posted: [],
  reversed: [],
}

export const canTransitionTransaction = (t: Pick<Transaction, 'status'>, to: TransactionStatus) => TRANSACTION_TRANSITIONS[t.status].includes(to)
export const nextTransactionStep = (t: Pick<Transaction, 'status'>) => TRANSACTION_TRANSITIONS[t.status][0] ?? null
export const TRANSACTION_ACTION_LABEL: Record<Exclude<TransactionStatus, 'draft'>, string> = {
  submitted: 'Submit for approval',
  approved: 'Approve',
  rejected: 'Reject',
  posted: 'Post',
  reversed: 'Reverse',
}

/** Only posted money moves the balance; a reversal is itself posted with the opposite kind. */
export const signed = (t: Pick<Transaction, 'kind' | 'amount'>) => (t.kind === 'cash_in' ? t.amount : -t.amount)
export const counts = (t: Pick<Transaction, 'status'>) => t.status === 'posted' || t.status === 'reversed'
export const awaitsApproval = (t: Pick<Transaction, 'status'>) => t.status === 'submitted' || t.status === 'approved'

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
  reference: string
  attachments: readonly Attachment[]
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function validateTransaction(input: TransactionInput, categories: readonly Category[]): Partial<Record<keyof TransactionInput, string>> {
  const errors: Partial<Record<keyof TransactionInput, string>> = {}
  if (!input.accountId) errors.accountId = 'Pick the account the money moves through.'
  const category = categories.find((c) => c.id === input.categoryId)
  if (!category) errors.categoryId = 'Pick a category.'
  else if (category.kind !== input.kind) errors.categoryId = `${category.name} is a ${KIND_LABEL[category.kind].toLowerCase()} category.`
  else if (!category.active) errors.categoryId = `${category.name} is archived.`
  else if (category.villaIds.length && input.villaId && !category.villaIds.includes(input.villaId)) errors.categoryId = `${category.name} is not enabled for this villa.`
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter a whole rupiah amount above zero.'
  if (!DATE.test(input.date)) errors.date = 'Pick the date.'
  if (!input.locationId) errors.locationId = 'Map the money to a location.'
  if (input.description.trim().length < 3) errors.description = 'Say what the money was for.'
  if (input.reference.length > 40) errors.reference = 'A reference is at most 40 characters.'
  return errors
}

/** Money moved between two accounts: a cash-out on the source and a cash-in on the target, linked. */
export interface CashTransferInput {
  fromAccountId: string
  toAccountId: string
  amount: number
  date: string
  description: string
  reference: string
}

export function validateTransfer(input: CashTransferInput, accounts: readonly CashAccount[]): Partial<Record<keyof CashTransferInput, string>> {
  const errors: Partial<Record<keyof CashTransferInput, string>> = {}
  if (!accounts.some((a) => a.id === input.fromAccountId)) errors.fromAccountId = 'Pick the account the money leaves.'
  if (!accounts.some((a) => a.id === input.toAccountId)) errors.toAccountId = 'Pick the account the money reaches.'
  else if (input.toAccountId === input.fromAccountId) errors.toAccountId = 'Pick two different accounts.'
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter a whole rupiah amount above zero.'
  if (!DATE.test(input.date)) errors.date = 'Pick the date.'
  if (input.description.trim().length < 3) errors.description = 'Say why the money moves.'
  return errors
}

/** A correction to one balance, with a mandatory reason; posted through the normal approval chain. */
export interface AdjustmentInput {
  accountId: string
  direction: 'increase' | 'decrease'
  amount: number
  date: string
  reason: string
}

export function validateAdjustment(input: AdjustmentInput, accounts: readonly CashAccount[]): Partial<Record<keyof AdjustmentInput, string>> {
  const errors: Partial<Record<keyof AdjustmentInput, string>> = {}
  if (!accounts.some((a) => a.id === input.accountId)) errors.accountId = 'Pick the account.'
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter a whole rupiah amount above zero.'
  if (!DATE.test(input.date)) errors.date = 'Pick the date.'
  if (input.reason.trim().length < 5) errors.reason = 'Give the reason for the correction.'
  return errors
}

/** A physical count against the book balance. A difference may become an adjustment entry. */
export interface Reconciliation {
  id: string
  accountId: string
  date: IsoDate
  expected: number
  counted: number
  difference: number
  note: string
  by: string
  adjustmentId: string | null
  /** Set when a cashier shift's closing count made the reconciliation. */
  shiftId?: string
}

export interface ReconciliationInput {
  accountId: string
  date: string
  counted: number
  note: string
  /** Post the difference as an adjustment entry for approval. */
  adjust: boolean
}

export function validateReconciliation(input: ReconciliationInput, accounts: readonly CashAccount[]): Partial<Record<keyof ReconciliationInput, string>> {
  const errors: Partial<Record<keyof ReconciliationInput, string>> = {}
  if (!accounts.some((a) => a.id === input.accountId)) errors.accountId = 'Pick the account.'
  if (!Number.isInteger(input.counted) || input.counted < 0) errors.counted = 'Enter the counted cash in whole rupiah.'
  if (!DATE.test(input.date)) errors.date = 'Pick the count date.'
  return errors
}

export interface TransactionFilter {
  status?: TransactionStatus | 'all'
  kind?: TransactionKind | 'all'
  categoryId?: string
  accountId?: string
  origin?: TransactionOrigin | 'all'
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
    if (f.origin && f.origin !== 'all' && t.origin !== f.origin) return false
    if (!withinRange(t.date, f.from, f.to)) return false
    if (q && ![t.number, t.description, t.reference, t.categoryName, t.accountName].some((v) => v.toLowerCase().includes(q))) return false
    return true
  })
}

/** Draft, Submitted, Approved, Posted; rejected and reversed records end in their own step. */
export function transactionSteps(t: Transaction, fmt: (iso: IsoDate) => string) {
  const order: TransactionStatus[] = ['draft', 'submitted', 'approved', 'posted']
  const at = t.status === 'reversed' ? 4 : t.status === 'rejected' ? 1 : order.indexOf(t.status)
  const when = (kind: TransactionEventKind) => t.history.filter((e) => e.kind === kind).at(-1)?.on
  const steps = order.map((s, i) => ({
    id: s,
    label: TRANSACTION_STATUS_LABEL[s],
    hint: s === 'draft' ? fmt(t.createdOn) : s === 'submitted' ? (when('submitted') ?? when('resubmitted')) && fmt((when('resubmitted') ?? when('submitted')) as IsoDate) : s === 'approved' ? when('approved') && fmt(when('approved') as IsoDate) : when('posted') && fmt(when('posted') as IsoDate),
    state: (i < at ? 'done' : i === at ? (t.status === 'rejected' ? 'late' : 'current') : 'upcoming') as 'done' | 'current' | 'upcoming' | 'late',
  }))
  if (t.status === 'rejected') {
    const step = steps[1]
    if (step) step.label = 'Rejected'
  }
  if (t.status === 'reversed') steps.push({ id: 'reversed', label: 'Reversed', hint: undefined, state: 'current' })
  return steps
}
