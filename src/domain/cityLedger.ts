import { addDays, daysBetween, type IsoDate } from '@/lib/dates'
import { RuleError } from './errors'
import type { FolioLine, FolioPart, FolioPosting, GuestFolio } from './folio'
import { lineAmount, type ServiceOrder } from './serviceOrder'
import { PB1_CODE, roundHalfUp, SERVICE_CODE } from './tax'

/**
 * The city ledger: companies and travel agents billed after the stay. The front desk transfers a
 * stay's bill, or the part the billing instruction covers, off the guest folio onto the account;
 * finance invoices the open items, books what the account pays and chases what is overdue.
 */

export type CityLedgerKind = 'company' | 'travel_agent'
export const CITY_LEDGER_KINDS: readonly CityLedgerKind[] = ['company', 'travel_agent']
export const CITY_LEDGER_KIND_LABEL: Record<CityLedgerKind, string> = { company: 'Company', travel_agent: 'Travel agent' }

/** What the account pays for; the rest stays on the guest's folio. */
export type BillingInstruction = 'all' | 'room' | 'room_breakfast'
export const BILLING_INSTRUCTIONS: readonly BillingInstruction[] = ['all', 'room', 'room_breakfast']
export const BILLING_INSTRUCTION_LABEL: Record<BillingInstruction, string> = { all: 'All charges', room: 'Room only', room_breakfast: 'Room and breakfast' }

export interface CityLedgerAccount {
  id: string
  /** CL-001 upward. */
  code: string
  name: string
  kind: CityLedgerKind
  contact: string
  /** Where invoices and statements go. */
  billingEmail: string
  phone: string
  address: string
  npwp: string
  /** What the account may owe at once, open invoices and stays still to transfer included. */
  creditLimit: number
  /** Days from the invoice date to its due date. */
  termsDays: number
  /** A travel agent's commission on the charges before service and PB1; zero for a company. */
  commissionPct: number
  active: boolean
  /** Villas the account may book; empty means every villa. */
  villaIds: readonly string[]
  createdOn: IsoDate
}
export type CityLedgerAccountInput = Omit<CityLedgerAccount, 'id' | 'code' | 'createdOn'>

export function validateCityLedgerAccount(input: CityLedgerAccountInput, accounts: readonly CityLedgerAccount[], id?: string): Partial<Record<keyof CityLedgerAccountInput, string>> {
  const errors: Partial<Record<keyof CityLedgerAccountInput, string>> = {}
  const name = input.name.trim()
  if (name.length < 3) errors.name = 'Name the company or agent.'
  else if (accounts.some((a) => a.name.toLowerCase() === name.toLowerCase() && a.id !== id)) errors.name = `${name} already has an account.`
  if (!CITY_LEDGER_KINDS.includes(input.kind)) errors.kind = 'Pick company or travel agent.'
  if (input.contact.trim().length < 2) errors.contact = 'Name the person who handles the bills.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.billingEmail.trim())) errors.billingEmail = 'Enter the billing email.'
  if (!Number.isInteger(input.creditLimit) || input.creditLimit < 0) errors.creditLimit = 'Enter the credit limit in whole rupiah.'
  if (!Number.isInteger(input.termsDays) || input.termsDays < 0 || input.termsDays > 120) errors.termsDays = '0 to 120 days.'
  if (!(input.commissionPct >= 0 && input.commissionPct <= 50)) errors.commissionPct = '0 to 50 percent.'
  else if (input.kind === 'company' && input.commissionPct > 0) errors.commissionPct = 'A company earns no commission.'
  return errors
}

/** What a direct booking or a group carries: the account billed, what it pays, and a credit limit override. */
export interface CityLedgerBilling {
  accountId: string
  instruction: BillingInstruction
  /** Set when finance or a manager booked past the credit limit. */
  override: { by: string; reason: string } | null
}

export interface CityLedgerBillingInput {
  accountId: string
  instruction: BillingInstruction
  /** Why finance or a manager books past the credit limit. */
  overrideReason?: string
}

/** The account may book the villa: active, and the villa on its list when it has one. */
export function assertBookable(a: Pick<CityLedgerAccount, 'name' | 'active' | 'villaIds'>, villaId: string, villaName: string) {
  if (!a.active) throw new RuleError('CITY_LEDGER_INACTIVE', `${a.name} is closed for new business.`)
  if (a.villaIds.length > 0 && !a.villaIds.includes(villaId)) throw new RuleError('CITY_LEDGER_VILLA', `${a.name} may not book ${villaName}.`)
}

/**
 * The credit limit: what the account owes, the stays booked to it but not transferred yet, and the
 * new booking may not pass the limit unless someone allowed to overrides with a reason.
 */
export function creditCheck(a: Pick<CityLedgerAccount, 'name' | 'creditLimit'>, used: number, adding: number, override: { may: boolean; reason: string; by: string }): CityLedgerBilling['override'] {
  if (used + adding <= a.creditLimit) return null
  const over = used + adding - a.creditLimit
  if (!override.may) throw new RuleError('CREDIT_LIMIT', `${a.name} would pass its credit limit of Rp ${a.creditLimit.toLocaleString('id-ID')} by Rp ${over.toLocaleString('id-ID')}. Finance or a villa manager may book it with a reason.`)
  if (override.reason.trim().length < 3) throw new RuleError('CREDIT_LIMIT', `${a.name} would pass its credit limit by Rp ${over.toLocaleString('id-ID')}. Give the reason to book it anyway.`)
  return { by: override.by, reason: override.reason.trim() }
}

/** One slice of a stay's bill moving to the account: its part of the folio, gross, with the service and PB1 inside it as billed. */
export interface TransferPart {
  part: FolioPart
  orderId: string | null
  amount: number
  service: number
  pb1: number
}

const CHARGE_SIDE = (l: FolioLine) => l.kind !== 'payment' && l.kind !== 'refund' && l.kind !== 'deposit' && l.kind !== 'channel' && l.kind !== 'transfer'

/** The gross, service and PB1 the charge lines of one slice of the folio carry, forecast nights included. */
function billed(lines: readonly FolioLine[]) {
  const charges = lines.filter(CHARGE_SIDE)
  const on = (pick: (code: string) => boolean) => charges.filter((l) => pick(l.code)).reduce((s, l) => s + l.debit - l.credit, 0)
  return { gross: on(() => true), service: on((c) => c === SERVICE_CODE), pb1: on((c) => c === PB1_CODE) }
}

/** `amount` of a slice with its share of the slice's service and PB1. */
function slice(lines: readonly FolioLine[], part: FolioPart, orderId: string | null, amount: number): TransferPart[] {
  if (amount <= 0) return []
  const b = billed(lines)
  const share = (tax: number) => (b.gross > 0 ? roundHalfUp((tax * Math.min(amount, b.gross)) / b.gross) : 0)
  return [{ part, orderId, amount, service: share(b.service), pb1: share(b.pb1) }]
}

/** Breakfast on an order as billed: the breakfast items not on the house, less the order discount. */
const breakfastCharge = (o: Pick<ServiceOrder, 'lines' | 'discountPct'>) =>
  Math.round(o.lines.filter((l) => l.category === 'breakfast' && !l.comp).reduce((s, l) => s + lineAmount(l), 0) * (1 - o.discountPct / 100))

/**
 * What a transfer under `instruction` moves off the folio: the room balance (forecast nights
 * included, so check-out leaves the guest nothing on the room), the breakfast on each unpaid order
 * for room and breakfast, and every part for all charges. `skip` leaves out orders that cannot move,
 * such as one waiting on a payment link.
 */
export function transferParts(f: Pick<GuestFolio, 'lines' | 'due'>, orders: readonly ServiceOrder[], instruction: BillingInstruction, skip: ReadonlySet<string> = new Set()): TransferPart[] {
  const room = slice(f.lines.filter((l) => l.part === 'room'), 'room', null, f.due.room)
  if (instruction === 'room') return room
  const perOrder = f.due.orders
    .filter((o) => !skip.has(o.orderId))
    .flatMap((o) => {
      const order = orders.find((x) => x.id === o.orderId)
      const amount = instruction === 'all' ? o.amount : Math.min(o.amount, order ? breakfastCharge(order) : 0)
      return slice(f.lines.filter((l) => l.orderId === o.orderId), 'orders', o.orderId, amount)
    })
  if (instruction === 'room_breakfast') return [...room, ...perOrder]
  return [...room, ...perOrder, ...slice(f.lines.filter((l) => l.part === 'charges'), 'charges', null, f.due.charges)]
}

export const partsTotal = (parts: readonly Pick<TransferPart, 'amount'>[]) => parts.reduce((s, p) => s + p.amount, 0)

export interface CityLedgerInvoiceLine {
  postingIds: readonly string[]
  bookingId: string
  code: string
  guest: string
  villa: string
  checkIn: IsoDate
  checkOut: IsoDate
  /** The billing instruction the stay was transferred under. */
  covers: string
  gross: number
  service: number
  pb1: number
}

/** One invoice per account and run: the open transferred items, with the tax kept as billed. */
export interface CityLedgerInvoice {
  id: string
  /** CL-YYYY-MM-NNN, numbered within the month of issue. */
  number: string
  accountId: string
  issuedOn: IsoDate
  dueOn: IsoDate
  lines: readonly CityLedgerInvoiceLine[]
  gross: number
  service: number
  pb1: number
  /** The agent's commission taken off at issue; zero for a company. */
  commissionPct: number
  commission: number
  /** What the account owes: gross less commission. */
  net: number
  /** The outbox message the invoice went out with, and when. */
  messageId: string | null
  sentAt: string | null
  journalId: string | null
  issuedBy: string
}

export const invoiceNumber = (issuedOn: IsoDate, existing: readonly Pick<CityLedgerInvoice, 'issuedOn'>[]) => {
  const month = issuedOn.slice(0, 7)
  const n = existing.filter((i) => i.issuedOn.slice(0, 7) === month).length + 1
  return `CL-${month}-${String(n).padStart(3, '0')}`
}

/** The invoice figures for `lines`: gross with service and PB1 as billed, the commission on the charges before them, and the net due. */
export function invoiceFigures(lines: readonly Pick<CityLedgerInvoiceLine, 'gross' | 'service' | 'pb1'>[], commissionPct: number) {
  const gross = lines.reduce((s, l) => s + l.gross, 0)
  const service = lines.reduce((s, l) => s + l.service, 0)
  const pb1 = lines.reduce((s, l) => s + l.pb1, 0)
  const commission = roundHalfUp(((gross - service - pb1) * commissionPct) / 100)
  return { gross, service, pb1, commissionPct, commission, net: gross - commission }
}

export const dueDate = (issuedOn: IsoDate, termsDays: number) => addDays(issuedOn, termsDays)

export type CityLedgerMethod = 'bank_transfer' | 'cash'
export const CITY_LEDGER_METHODS: readonly CityLedgerMethod[] = ['bank_transfer', 'cash']

/** Money the account sent, a cash-in through approval, spread over its invoices; what is not spread is a credit. */
export interface CityLedgerPayment {
  id: string
  /** CLP-0001 upward. */
  number: string
  accountId: string
  date: IsoDate
  method: CityLedgerMethod
  amount: number
  reference: string
  note: string
  allocations: ReadonlyArray<{ invoiceId: string; amount: number }>
  transactionId: string
  createdBy: string
}

export interface CityLedgerPaymentInput {
  accountId: string
  method: CityLedgerMethod
  /** The bank or cashbox the money landed in. */
  cashAccountId: string
  amount: number
  reference: string
  note: string
  /** Picked invoices, or null to pay the oldest first. */
  allocations: ReadonlyArray<{ invoiceId: string; amount: number }> | null
}

export function validateCityLedgerPayment(input: CityLedgerPaymentInput): Partial<Record<keyof CityLedgerPaymentInput, string>> {
  const errors: Partial<Record<keyof CityLedgerPaymentInput, string>> = {}
  if (!input.accountId) errors.accountId = 'Pick the account that paid.'
  if (!CITY_LEDGER_METHODS.includes(input.method)) errors.method = 'Bank transfer or cash.'
  if (!input.cashAccountId) errors.cashAccountId = 'Pick where the money landed.'
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter the amount in whole rupiah.'
  if (input.method === 'bank_transfer' && input.reference.trim().length < 3) errors.reference = 'Enter the bank reference.'
  if (input.allocations?.some((a) => !Number.isInteger(a.amount) || a.amount < 0)) errors.allocations = 'Allocate whole rupiah.'
  else if (input.allocations && input.allocations.reduce((s, a) => s + a.amount, 0) > input.amount) errors.allocations = 'The invoices picked take more than the payment.'
  return errors
}

/** Splits `amount` over invoices oldest first, each up to what it still has open. */
export function oldestFirst(amount: number, open: ReadonlyArray<{ invoiceId: string; open: number }>) {
  let left = amount
  return open.flatMap((i) => {
    const take = Math.min(left, Math.max(0, i.open))
    left -= take
    return take > 0 ? [{ invoiceId: i.invoiceId, amount: take }] : []
  })
}

/** The largest balance finance writes off; anything bigger goes to collection. */
export const WRITE_OFF_LIMIT = 500_000

/** A small balance written off with the reason, signed and posted as a manual journal. */
export interface CityLedgerWriteOff {
  id: string
  number: string
  accountId: string
  invoiceId: string | null
  amount: number
  reason: string
  manualJournalId: string
  createdBy: string
  createdOn: IsoDate
}

export function validateWriteOff(input: { amount: number; reason: string }, open: number): Partial<Record<'amount' | 'reason', string>> {
  const errors: Partial<Record<'amount' | 'reason', string>> = {}
  if (!Number.isInteger(input.amount) || input.amount <= 0) errors.amount = 'Enter the amount in whole rupiah.'
  else if (input.amount > open) errors.amount = `Only ${open} is open.`
  if (input.reason.trim().length < 5) errors.reason = 'Say why the balance is written off.'
  return errors
}

export function assertWriteOffLimit(amount: number) {
  if (amount > WRITE_OFF_LIMIT) throw new RuleError('WRITE_OFF_LIMIT', `Write-offs go up to Rp ${WRITE_OFF_LIMIT.toLocaleString('id-ID')}; send a bigger balance to collection.`)
}

/** What has settled each invoice: posted payments, posted write-offs, and what still waits for approval. */
interface InvoiceSettlement {
  paid: number
  writtenOff: number
  pending: number
  open: number
}

export interface SettlementSources {
  payments: readonly CityLedgerPayment[]
  writeOffs: readonly CityLedgerWriteOff[]
  /** Whether a payment's cash-in counts in the books: posted. */
  paymentPosted: (p: CityLedgerPayment) => boolean
  /** Whether it is still alive: submitted, approved or posted. */
  paymentLive: (p: CityLedgerPayment) => boolean
  writeOffPosted: (w: CityLedgerWriteOff) => boolean
  writeOffLive: (w: CityLedgerWriteOff) => boolean
}

const LIVE: ReadonlySet<string | undefined> = new Set(['submitted', 'approved', 'posted'])

/** Payments settle by their cash-in's status and write-offs by their manual journal's: posted counts, rejected or reversed never does. */
export const statusRules = (txStatus: (id: string) => string | undefined, journalStatus: (id: string) => string | undefined): Omit<SettlementSources, 'payments' | 'writeOffs'> => ({
  paymentPosted: (p) => txStatus(p.transactionId) === 'posted',
  paymentLive: (p) => LIVE.has(txStatus(p.transactionId)),
  writeOffPosted: (w) => journalStatus(w.manualJournalId) === 'posted',
  writeOffLive: (w) => LIVE.has(journalStatus(w.manualJournalId)),
})

/** What is still open on each invoice for new allocations: net less every live payment and write-off on it. */
export function allocatable(invoices: readonly CityLedgerInvoice[], src: SettlementSources) {
  return [...invoices]
    .sort((a, b) => a.issuedOn.localeCompare(b.issuedOn) || a.number.localeCompare(b.number))
    .map((i) => {
      const s = invoiceSettlement(i, src)
      return { invoiceId: i.id, open: s.open - s.pending }
    })
}

export function invoiceSettlement(inv: Pick<CityLedgerInvoice, 'id' | 'net'>, src: SettlementSources): InvoiceSettlement {
  const allocated = (pick: (p: CityLedgerPayment) => boolean) => src.payments.filter(pick).reduce((s, p) => s + p.allocations.filter((a) => a.invoiceId === inv.id).reduce((x, a) => x + a.amount, 0), 0)
  const written = (pick: (w: CityLedgerWriteOff) => boolean) => src.writeOffs.filter((w) => w.invoiceId === inv.id && pick(w)).reduce((s, w) => s + w.amount, 0)
  const paid = allocated(src.paymentPosted)
  const writtenOff = written(src.writeOffPosted)
  const pending = allocated((p) => src.paymentLive(p) && !src.paymentPosted(p)) + written((w) => src.writeOffLive(w) && !src.writeOffPosted(w))
  return { paid, writtenOff, pending, open: inv.net - paid - writtenOff }
}

export type InvoiceState = 'open' | 'partly_paid' | 'paid' | 'overdue'
export const INVOICE_STATE_LABEL: Record<InvoiceState, string> = { open: 'Open', partly_paid: 'Partly paid', paid: 'Paid', overdue: 'Overdue' }

export function invoiceState(inv: Pick<CityLedgerInvoice, 'dueOn' | 'net'>, s: Pick<InvoiceSettlement, 'open'>, today: IsoDate): InvoiceState {
  if (s.open <= 0) return 'paid'
  if (inv.dueOn < today) return 'overdue'
  return s.open < inv.net ? 'partly_paid' : 'open'
}

export type CityAgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90'
export const CITY_AGING_BUCKETS: readonly CityAgingBucket[] = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90']
export const CITY_AGING_LABEL: Record<CityAgingBucket, string> = { current: 'Current', d1_30: '1 to 30 days', d31_60: '31 to 60 days', d61_90: '61 to 90 days', d90: 'Over 90 days' }

/** Days past the due date into buckets; not yet due, or not yet invoiced, is current. */
function cityAgingBucket(dueOn: IsoDate | null, today: IsoDate): CityAgingBucket {
  const late = dueOn ? daysBetween(dueOn, today) : 0
  if (late <= 0) return 'current'
  if (late <= 30) return 'd1_30'
  if (late <= 60) return 'd31_60'
  if (late <= 90) return 'd61_90'
  return 'd90'
}

export const daysOverdue = (dueOn: IsoDate, today: IsoDate) => Math.max(0, daysBetween(dueOn, today))

export type LedgerItemKind = 'transfer' | 'commission' | 'payment' | 'write_off'
export const LEDGER_ITEM_LABEL: Record<LedgerItemKind, string> = { transfer: 'Transfer', commission: 'Agent commission', payment: 'Payment', write_off: 'Write-off' }

export interface LedgerItem {
  date: IsoDate
  kind: LedgerItemKind
  /** The record behind it: a booking code, an invoice number, a payment number. */
  ref: string
  /** Where it opens in the console. */
  href: string | null
  description: string
  debit: number
  credit: number
}

/** Items oldest first with the balance after each; debits are what the account owes. */
export function runningLedger(items: readonly LedgerItem[]) {
  let balance = 0
  const order: Record<LedgerItemKind, number> = { transfer: 0, commission: 1, write_off: 2, payment: 3 }
  const lines = [...items].sort((a, b) => a.date.localeCompare(b.date) || order[a.kind] - order[b.kind] || a.ref.localeCompare(b.ref)).map((i) => ({ ...i, balance: (balance += i.debit - i.credit) }))
  return { lines, balance }
}

/**
 * The open balance in the aging buckets: each invoice's open amount by days past its due date,
 * transfers not invoiced yet as current, and credit the account has not spread yet off the top.
 */
export function agingOf(invoices: ReadonlyArray<{ dueOn: IsoDate; open: number }>, uninvoiced: number, credit: number, today: IsoDate): Record<CityAgingBucket, number> {
  const out: Record<CityAgingBucket, number> = { current: uninvoiced, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 }
  for (const i of invoices) if (i.open > 0) out[cityAgingBucket(i.dueOn, today)] += i.open
  out.current -= credit
  return out
}

export interface LedgerSources extends SettlementSources {
  transfers: readonly FolioPosting[]
  invoices: readonly CityLedgerInvoice[]
  bookingCode: (bookingId: string) => string
}

/**
 * Everything on one account as the books carry it: transfers in (one item per stay and day),
 * commissions, posted payments and posted write-offs out. Money still in approval stays off.
 */
export function ledgerItems(accountId: string, src: LedgerSources): LedgerItem[] {
  const mine = src.transfers.filter((p) => p.kind === 'transfer' && p.cityLedger?.accountId === accountId)
  const keys = [...new Set(mine.map((p) => `${p.bookingId}|${p.date}`))]
  const transfers: LedgerItem[] = keys.map((key) => {
    const [bookingId = '', date = ''] = key.split('|')
    const parts = mine.filter((p) => p.bookingId === bookingId && p.date === date)
    return { date, kind: 'transfer', ref: src.bookingCode(bookingId), href: `/bookings/${bookingId}/folio`, description: `Stay transferred, ${BILLING_INSTRUCTION_LABEL[parts[0]?.cityLedger?.instruction ?? 'all'].toLowerCase()}`, debit: parts.reduce((s, p) => s + p.amount, 0), credit: 0 }
  })
  const commissions: LedgerItem[] = src.invoices
    .filter((i) => i.accountId === accountId && i.commission > 0)
    .map((i) => ({ date: i.issuedOn, kind: 'commission', ref: i.number, href: `/city-ledger/invoices/${i.id}`, description: `${i.commissionPct}% commission on ${i.number}`, debit: 0, credit: i.commission }))
  const payments: LedgerItem[] = src.payments
    .filter((p) => p.accountId === accountId && src.paymentPosted(p))
    .map((p) => ({ date: p.date, kind: 'payment', ref: p.number, href: `/finance/transactions/${p.transactionId}`, description: `Payment${p.reference ? `, ${p.reference}` : ''}`, debit: 0, credit: p.amount }))
  const writeOffs: LedgerItem[] = src.writeOffs
    .filter((w) => w.accountId === accountId && src.writeOffPosted(w))
    .map((w) => ({ date: w.createdOn, kind: 'write_off', ref: w.number, href: `/accounting/manual/${w.manualJournalId}`, description: w.reason, debit: 0, credit: w.amount }))
  return [...transfers, ...commissions, ...payments, ...writeOffs]
}

/** What the account owes in the books: transfers less commissions, posted payments and posted write-offs. */
export const accountBalance = (accountId: string, src: LedgerSources) => ledgerItems(accountId, src).reduce((s, i) => s + i.debit - i.credit, 0)

/** Transfers not on any invoice yet. */
export function openTransfers(accountId: string, transfers: readonly FolioPosting[], invoices: readonly Pick<CityLedgerInvoice, 'lines'>[]) {
  const invoiced = new Set(invoices.flatMap((i) => i.lines.flatMap((l) => l.postingIds)))
  return transfers.filter((p) => p.kind === 'transfer' && p.cityLedger?.accountId === accountId && !invoiced.has(p.id))
}

/** What a payment has not spread over invoices yet: a credit on the account. */
export const unapplied = (p: Pick<CityLedgerPayment, 'amount' | 'allocations'>) => p.amount - p.allocations.reduce((s, a) => s + a.amount, 0)
