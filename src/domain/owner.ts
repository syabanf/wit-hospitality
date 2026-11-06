import { addDays, addMonths, daysBetween, maxIso, minIso, type IsoDate } from '@/lib/dates'
import type { Attachment } from './attachment'
import { chargedBetween, earns, overlapNights, SOURCE_LABEL, type Booking, type UnitBlock } from './booking'
import { RuleError } from './errors'
import { counts, type Category, type Transaction, type TransactionStatus } from './finance'
import { costByVilla, type PayrollPeriod } from './payroll'
import type { Unit } from './property'

/**
 * Villas that belong to individual investors and run under a management contract. The operator
 * keeps collecting and paying on the owner's behalf; each month a statement works out the owner's
 * share of the villa's result, finance closes it, the owner of the operator approves it, and a
 * payout cash-out from the bank pays it.
 */
export interface BankAccount {
  bank: string
  accountName: string
  accountNumber: string
}

export interface VillaOwner {
  id: string
  name: string
  email: string
  phone: string
  bank: BankAccount
  /** Indonesian tax id, when the owner gave one. */
  npwp: string
  /** The portal login, when the owner has one. */
  userId: string | null
}

export type VillaOwnerInput = Omit<VillaOwner, 'id'>

/** What the percentage fee is taken from. */
export type FeeBasis = 'room' | 'gross' | 'gop'
export const FEE_BASIS_LABEL: Record<FeeBasis, string> = { room: 'Room revenue', gross: 'Gross revenue', gop: 'Gross operating profit' }

/** Which costs the owner bears; Airbnb fees are always the owner's, being the cost of the revenue. */
export type ChargedExpenses = 'operating' | 'maintenance' | 'all'
export const CHARGED_LABEL: Record<ChargedExpenses, string> = {
  operating: 'Operating expenses of the villa',
  maintenance: 'Maintenance above a threshold',
  all: 'Everything, payroll allocation included',
}

/** How an owner's own stay is priced: free, a cleaning fee per stay, or a rate per night. */
export type OwnerStayPricing = 'free' | 'cleaning' | 'rate'
export const OWNER_STAY_PRICING_LABEL: Record<OwnerStayPricing, string> = { free: 'Free', cleaning: 'Cleaning fee per stay', rate: 'Owner rate per night' }

/**
 * What happens when a month's costs and fee exceed its revenue: the shortfall carries forward as a
 * deduction from the next statements, or the owner tops it up in cash.
 */
export type Shortfall = 'carry' | 'topup'
export const SHORTFALL_LABEL: Record<Shortfall, string> = { carry: 'Carry forward to the next statement', topup: 'Owner tops up in cash' }

export interface ContractInput {
  villaId: string
  ownerId: string
  start: IsoDate
  /** Inclusive. */
  end: IsoDate
  feeBasis: FeeBasis
  feePct: number
  fixedMonthlyFee: number
  charged: ChargedExpenses
  /** For `maintenance`: entries from this amount are the owner's, smaller ones the operator's. */
  maintenanceThreshold: number
  ownerNightsPerYear: number
  ownerStayPricing: OwnerStayPricing
  /** Per stay for `cleaning`, per night for `rate`. */
  ownerStayPrice: number
  /** FF&E reserve held back, as a percent of total revenue. */
  reservePct: number
  /** Day of the next month the payout is due. */
  payoutDay: number
  shortfall: Shortfall
  document: Attachment | null
}

export interface ManagementContract extends ContractInput {
  id: string
  number: string
  createdOn: IsoDate
}

export function validateContract(input: ContractInput, contracts: readonly ManagementContract[], excludeId?: string): Partial<Record<keyof ContractInput, string>> {
  const errors: Partial<Record<keyof ContractInput, string>> = {}
  const pct = (v: number) => Number.isFinite(v) && v >= 0 && v <= 100
  if (!input.villaId) errors.villaId = 'Pick the villa.'
  if (!input.ownerId) errors.ownerId = 'Pick the owner.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start)) errors.start = 'Pick the start date.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.end) || input.end <= input.start) errors.end = 'End after the start.'
  if (!pct(input.feePct)) errors.feePct = 'A fee between 0 and 100 percent.'
  if (!pct(input.reservePct)) errors.reservePct = 'A reserve between 0 and 100 percent.'
  if (!Number.isInteger(input.fixedMonthlyFee) || input.fixedMonthlyFee < 0) errors.fixedMonthlyFee = 'Whole rupiah, zero or more.'
  if (!Number.isInteger(input.maintenanceThreshold) || input.maintenanceThreshold < 0) errors.maintenanceThreshold = 'Whole rupiah, zero or more.'
  if (!Number.isInteger(input.ownerNightsPerYear) || input.ownerNightsPerYear < 0 || input.ownerNightsPerYear > 365) errors.ownerNightsPerYear = 'Nights from 0 to 365.'
  if (!Number.isInteger(input.ownerStayPrice) || input.ownerStayPrice < 0) errors.ownerStayPrice = 'Whole rupiah, zero or more.'
  if (!Number.isInteger(input.payoutDay) || input.payoutDay < 1 || input.payoutDay > 28) errors.payoutDay = 'A day from 1 to 28.'
  if (!errors.start && !errors.end && contracts.some((c) => c.id !== excludeId && c.villaId === input.villaId && c.start <= input.end && input.start <= c.end)) errors.villaId = 'Another contract covers this villa on some of those dates.'
  return errors
}

export const monthEnd = (month: string) => addDays(addMonths(`${month}-01`, 1), -1)

/** Whether the contract runs for at least one day of the month. */
export const coversMonth = (c: Pick<ManagementContract, 'start' | 'end'>, month: string) => c.start <= monthEnd(month) && `${month}-01` <= c.end

/** Maintenance spending: work order expenses and the maintenance categories. */
const MAINTENANCE_CATEGORIES: ReadonlySet<string> = new Set(['cat-maint', 'cat-pool'])
export const isMaintenance = (t: Pick<Transaction, 'origin' | 'categoryId'>) => t.origin === 'maintenance' || MAINTENANCE_CATEGORIES.has(t.categoryId)

/** Cash entries that move money between accounts or pay the owner; the villa P&L leaves them out. */
const NOT_VILLA_RESULT = new Set(['transfer', 'adjustment', 'reconciliation', 'owner_payout'])
const NOT_OTHER_INCOME = new Set(['cat-room', 'cat-airbnb', 'cat-deposit'])

export type EntryRole = 'other' | 'expense'

/**
 * Where a posted villa entry sits in the villa P&L, the same rules the profit and loss reports
 * apply: other income besides guest room money, and expenses besides payroll and guest refunds.
 */
export function villaEntryRole(t: Pick<Transaction, 'status' | 'origin' | 'kind' | 'categoryId' | 'bookingId' | 'reversalOf' | 'reversedBy'>): EntryRole | null {
  if (!counts(t) || NOT_VILLA_RESULT.has(t.origin) || t.reversalOf || t.reversedBy) return null
  if (t.kind === 'cash_in') return NOT_OTHER_INCOME.has(t.categoryId) ? null : 'other'
  if (t.origin === 'payroll' || (t.categoryId === 'cat-other' && t.bookingId)) return null
  return 'expense'
}

/** One stay's share of the month, without the guest: what the owner sees. */
export interface StatementStay {
  bookingId: string
  code: string
  unitCode: string
  checkIn: IsoDate
  checkOut: IsoDate
  source: string
  nights: number
  revenue: number
  fee: number
}

export interface StatementEntry {
  transactionId: string
  number: string
  date: IsoDate
  description: string
  category: string
  role: EntryRole
  amount: number
  /** For a maintenance contract: the entry is the owner's. */
  charged: boolean
}

/** The month's figures the books give, before the contract applies. */
export interface StatementBase {
  roomRevenue: number
  otherRevenue: number
  airbnbFees: number
  expenses: number
  payroll: number
  /** Maintenance entries at or over the contract's threshold. */
  maintenanceCharged: number
  ownerNights: number
  ownerStays: number
}

export interface StatementFigures extends StatementBase {
  totalRevenue: number
  /** Costs the contract puts on the owner. */
  charged: number
  /** Revenue less charged costs: the villa result the owner and operator share. */
  gop: number
  managementFee: number
  reserve: number
  ownerStayCharge: number
  netPayable: number
}

const round = (v: number) => Math.round(v)

/** The contract applied to a month of the books. */
export function statementFigures(c: Pick<ContractInput, 'feeBasis' | 'feePct' | 'fixedMonthlyFee' | 'charged' | 'reservePct' | 'ownerStayPricing' | 'ownerStayPrice'>, base: StatementBase): StatementFigures {
  const totalRevenue = base.roomRevenue + base.otherRevenue
  const costs = { operating: base.airbnbFees + base.expenses, maintenance: base.airbnbFees + base.maintenanceCharged, all: base.airbnbFees + base.expenses + base.payroll }
  const charged = costs[c.charged]
  const gop = totalRevenue - charged
  const feeBase = { room: base.roomRevenue, gross: totalRevenue, gop: Math.max(0, gop) }[c.feeBasis]
  const managementFee = round((feeBase * c.feePct) / 100) + c.fixedMonthlyFee
  const reserve = round((totalRevenue * c.reservePct) / 100)
  const ownerStayCharge = c.ownerStayPricing === 'cleaning' ? base.ownerStays * c.ownerStayPrice : c.ownerStayPricing === 'rate' ? base.ownerNights * c.ownerStayPrice : 0
  return { ...base, totalRevenue, charged, gop, managementFee, reserve, ownerStayCharge, netPayable: gop - managementFee - reserve - ownerStayCharge }
}

/** Owner stay nights inside [from, to) on the villa's units, and the stays that start in it. */
export function ownerNightsIn(blocks: readonly UnitBlock[], unitIds: ReadonlySet<string>, from: IsoDate, to: IsoDate) {
  const mine = blocks.filter((b) => b.reason === 'owner' && unitIds.has(b.unitId))
  return { nights: mine.reduce((s, b) => s + overlapNights(b.from, b.to, from, to), 0), stays: mine.filter((b) => b.from >= from && b.from < to).length }
}

/** The records a month's statement reads. */
export interface StatementBooks {
  bookings: readonly Booking[]
  blocks: readonly UnitBlock[]
  transactions: readonly Transaction[]
  categories: ReadonlyArray<Pick<Category, 'id' | 'name'>>
  /** Airbnb host accounts, to name the source of a stay. */
  accounts: ReadonlyArray<{ id: string; name: string }>
  periods: ReadonlyArray<Pick<PayrollPeriod, 'month' | 'status' | 'lines'>>
  units: ReadonlyArray<Pick<Unit, 'id' | 'code' | 'villaId'>>
}

/**
 * A contract's month from the books, by the rules of the villa P&L (`pnl-villa`): room revenue night
 * by night inside the month, Airbnb fees on arrivals, other income and expenses from the villa's
 * posted entries, payroll from the month's closed payroll. The lines behind each figure come along.
 */
export function statementDraft(c: ContractInput, month: string, books: StatementBooks) {
  const from = `${month}-01`
  const to = monthEnd(month)
  const end = addDays(to, 1)
  const units = books.units.filter((u) => u.villaId === c.villaId)
  const unitIds = new Set(units.map((u) => u.id))
  const stays: StatementStay[] = books.bookings
    .filter((b) => unitIds.has(b.unitId) && earns(b))
    .map((b) => ({
      bookingId: b.id,
      code: b.code,
      unitCode: b.unitAssigned ? (units.find((u) => u.id === b.unitId)?.code ?? '') : 'Unassigned',
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      source: b.airbnbAccountId ? (books.accounts.find((a) => a.id === b.airbnbAccountId)?.name ?? SOURCE_LABEL[b.source]) : SOURCE_LABEL[b.source],
      nights: overlapNights(b.checkIn, b.checkOut, from, end),
      revenue: chargedBetween(b, from, end),
      fee: b.source === 'airbnb' && b.checkIn >= from && b.checkIn <= to ? b.airbnbFee : 0,
    }))
    .filter((x) => x.revenue > 0 || x.fee > 0)
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn))
  const maintenance = c.charged === 'maintenance'
  const entries: StatementEntry[] = books.transactions
    .filter((t) => t.villaId === c.villaId && t.date >= from && t.date <= to)
    .flatMap((t) => {
      const role = villaEntryRole(t)
      if (!role) return []
      const charged = maintenance && role === 'expense' && isMaintenance(t) && t.amount >= c.maintenanceThreshold
      return [{ transactionId: t.id, number: t.number, date: t.date, description: t.description, category: books.categories.find((x) => x.id === t.categoryId)?.name ?? t.categoryId, role, amount: t.amount, charged }]
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  const total = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
  const owned = ownerNightsIn(books.blocks, unitIds, from, end)
  const base: StatementBase = {
    roomRevenue: total(stays.map((x) => x.revenue)),
    otherRevenue: total(entries.filter((e) => e.role === 'other').map((e) => e.amount)),
    airbnbFees: total(stays.map((x) => x.fee)),
    expenses: total(entries.filter((e) => e.role === 'expense').map((e) => e.amount)),
    payroll: total(books.periods.filter((p) => p.status === 'closed' && p.month === month).map((p) => costByVilla(p.lines).get(c.villaId) ?? 0)),
    maintenanceCharged: total(entries.filter((e) => e.charged).map((e) => e.amount)),
    ownerNights: owned.nights,
    ownerStays: owned.stays,
  }
  return { base, figures: statementFigures(c, base), stays, entries }
}

/**
 * A closed statement keeps its figures and the stays and entries behind them, so it reads the
 * same after the books move on. Approval opens it to the owner; the payout cash-out pays it.
 */
export type StatementStatus = 'closed' | 'approved'

export interface OwnerStatement {
  id: string
  number: string
  contractId: string
  ownerId: string
  villaId: string
  /** "YYYY-MM". */
  month: string
  figures: StatementFigures
  stays: readonly StatementStay[]
  entries: readonly StatementEntry[]
  status: StatementStatus
  /** The earlier month whose shortfall this statement deducts, and the amount brought forward. */
  broughtFrom: string | null
  broughtForward: number
  /** Net payable after the amount brought forward: paid out when positive, carried or topped up when negative. */
  payable: number
  /** The contract's rule for a shortfall when the statement closed. */
  shortfall: Shortfall
  closedBy: string
  closedById: string
  closedOn: IsoDate
  approvedBy: string | null
  approvedOn: IsoDate | null
  note: string
  /** The latest payout cash-out, or the owner's top-up cash-in; a rejected one can be followed by another. */
  payoutTransactionId: string | null
  /** The close journal entry. */
  journalId: string | null
}

export interface StatementClose {
  contractId: string
  month: string
  base: StatementBase
  stays: readonly StatementStay[]
  entries: readonly StatementEntry[]
  note: string
}

export const statementNumber = (month: string, villaCode: string) => `OS-${month}-${villaCode}`

/** The contract's latest closed statement before the month. */
export const previousStatement = <T extends Pick<OwnerStatement, 'contractId' | 'month'>>(statements: readonly T[], contractId: string, month: string): T | null =>
  statements.filter((s) => s.contractId === contractId && s.month < month).reduce<T | null>((last, s) => (!last || s.month > last.month ? s : last), null)

/**
 * A shortfall carried forward stays owed by the owner until a later month covers it: the next
 * statement deducts it before anything is paid. A topped-up shortfall is settled in cash instead.
 */
export function settlement(netPayable: number, previous: Pick<OwnerStatement, 'month' | 'payable' | 'shortfall'> | null) {
  const owed = previous && previous.shortfall === 'carry' && previous.payable < 0 ? -previous.payable : 0
  return { broughtFrom: owed ? (previous?.month ?? null) : null, broughtForward: owed, payable: netPayable - owed }
}

/** Where the payout stands, read off its cash-out. */
export type PayoutState = 'none' | 'waiting' | 'paid' | 'rejected'
export const PAYOUT_STATE_LABEL: Record<PayoutState, string> = { none: 'Not paid', waiting: 'Being approved', paid: 'Paid', rejected: 'Payout rejected' }
export function payoutState(status: TransactionStatus | null): PayoutState {
  if (status === null) return 'none'
  if (status === 'posted') return 'paid'
  if (status === 'rejected' || status === 'reversed') return 'rejected'
  return 'waiting'
}

const TOP_UP_LABEL: Record<PayoutState, string> = { none: 'Owner to top up', waiting: 'Top-up due', paid: 'Topped up', rejected: 'Top-up rejected' }

/** A negative payable the owner tops up in cash; the statement's cash entry is then a cash-in. */
export const topsUp = (st: Pick<OwnerStatement, 'payable' | 'shortfall'>) => st.shortfall === 'topup' && st.payable < 0

export function statementLabel(st: Pick<OwnerStatement, 'status' | 'payable' | 'shortfall'>, payout: PayoutState) {
  if (st.status === 'closed') return 'Awaiting approval'
  if (topsUp(st)) return TOP_UP_LABEL[payout]
  if (st.payable < 0) return 'Carried forward'
  if (st.payable === 0) return 'Nothing to pay'
  return payout === 'none' ? 'To pay' : PAYOUT_STATE_LABEL[payout]
}

/** The payout is due on the contract's day of the month after. */
export const payoutDue = (month: string, payoutDay: number) => `${addMonths(`${month}-01`, 1).slice(0, 7)}-${String(payoutDay).padStart(2, '0')}`

/** Refuses a close the month or the contract does not allow. */
export function assertClosableStatement(c: ManagementContract, month: string, today: IsoDate, statements: readonly OwnerStatement[], pendingInMonth: number) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RuleError('VALIDATION_ERROR', 'Pick a month as YYYY-MM.')
  if (month >= today.slice(0, 7)) throw new RuleError('STATEMENT_MONTH_OPEN', 'The month has not ended yet; close its statement from the 1st of the next month.')
  if (!coversMonth(c, month)) throw new RuleError('CONTRACT_NOT_ACTIVE', `Contract ${c.number} does not run in ${month}.`)
  if (statements.some((s) => s.contractId === c.id && s.month === month)) throw new RuleError('STATEMENT_CLOSED', `The ${month} statement of ${c.number} is already closed.`)
  // A later statement already settled what came before it, so months close in order.
  const later = statements.find((s) => s.contractId === c.id && s.month > month)
  if (later) throw new RuleError('STATEMENT_ORDER', `${later.number} is already closed; reopen it before closing an earlier month.`)
  if (pendingInMonth > 0) throw new RuleError('STATEMENT_PENDING', `${pendingInMonth} ${pendingInMonth === 1 ? 'entry' : 'entries'} of the villa dated in ${month} still ${pendingInMonth === 1 ? 'waits' : 'wait'} for approval or posting.`)
}

/**
 * Reopening takes a closed statement back to open so corrections flow into it and the months after.
 * Only the contract's latest statement reopens, and only while nothing was paid or is being paid.
 */
export function assertReopenable(st: OwnerStatement, statements: readonly OwnerStatement[], payout: { number: string; status: TransactionStatus } | null, reason: string) {
  if (reason.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the statement reopens.')
  const later = statements.find((s) => s.contractId === st.contractId && s.month > st.month)
  if (later) throw new RuleError('STATEMENT_ORDER', `${later.number} comes after ${st.number}; reopen it first.`)
  const state = payoutState(payout?.status ?? null)
  if (state === 'paid') throw new RuleError('STATEMENT_PAID', `${st.number} is settled by ${payout?.number}; it no longer reopens.`)
  if (state === 'waiting') throw new RuleError('PAYOUT_OPEN', `${st.number} has ${payout?.number} waiting for approval; reject it before reopening.`)
}

/** The drill-down must add up to the figures it explains. */
export function assertDrillDown(base: StatementBase, stays: readonly StatementStay[], entries: readonly StatementEntry[]) {
  const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
  const checks: Array<[string, number, number]> = [
    ['Room revenue', base.roomRevenue, sum(stays.map((s) => s.revenue))],
    ['Airbnb fees', base.airbnbFees, sum(stays.map((s) => s.fee))],
    ['Other revenue', base.otherRevenue, sum(entries.filter((e) => e.role === 'other').map((e) => e.amount))],
    ['Expenses', base.expenses, sum(entries.filter((e) => e.role === 'expense').map((e) => e.amount))],
    ['Maintenance charged', base.maintenanceCharged, sum(entries.filter((e) => e.charged).map((e) => e.amount))],
  ]
  const off = checks.find(([, figure, lines]) => figure !== lines)
  if (off) throw new RuleError('STATEMENT_MISMATCH', `${off[0]} of ${off[1]} differs from its lines, which add up to ${off[2]}.`)
}

/** An owner's request to stay in their own villa; approval puts an owner block on a unit. */
export type OwnerStayStatus = 'pending' | 'approved' | 'declined' | 'cancelled'
export const OWNER_STAY_STATUS_LABEL: Record<OwnerStayStatus, string> = { pending: 'Waiting for the operator', approved: 'Approved', declined: 'Declined', cancelled: 'Cancelled' }

export interface OwnerStayInput {
  contractId: string
  checkIn: IsoDate
  checkOut: IsoDate
  guests: number
  note: string
}

export interface OwnerStayRequest extends OwnerStayInput {
  id: string
  number: string
  ownerId: string
  villaId: string
  status: OwnerStayStatus
  requestedOn: IsoDate
  unitId: string | null
  blockId: string | null
  decidedBy: string | null
  decidedOn: IsoDate | null
  decisionNote: string
}

/** Nights of the year's approved and waiting owner stays under one contract. */
export function ownerNightsUsed(requests: readonly OwnerStayRequest[], contractId: string, year: string, excludeId?: string) {
  const from = `${year}-01-01`
  const to = `${Number(year) + 1}-01-01`
  return requests.filter((r) => r.contractId === contractId && r.id !== excludeId && (r.status === 'approved' || r.status === 'pending')).reduce((s, r) => s + overlapNights(r.checkIn, r.checkOut, from, to), 0)
}

export function validateOwnerStay(input: OwnerStayInput, c: ManagementContract, requests: readonly OwnerStayRequest[], today: IsoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(input.checkOut) || input.checkOut <= input.checkIn) throw new RuleError('OWNER_STAY_DATES', 'Pick an arrival and a later departure.')
  if (input.checkIn < today) throw new RuleError('OWNER_STAY_DATES', 'Pick an arrival from today on.')
  if (input.checkIn < c.start || input.checkOut > addDays(c.end, 1)) throw new RuleError('OWNER_STAY_DATES', `The contract runs from ${c.start} to ${c.end}.`)
  if (!Number.isInteger(input.guests) || input.guests < 1) throw new RuleError('VALIDATION_ERROR', 'At least one guest.')
  // Each calendar year the stay touches counts against that year's allowance.
  for (let y = Number(input.checkIn.slice(0, 4)); y <= Number(addDays(input.checkOut, -1).slice(0, 4)); y++) {
    const year = String(y)
    const asked = overlapNights(input.checkIn, input.checkOut, `${year}-01-01`, `${y + 1}-01-01`)
    const used = ownerNightsUsed(requests, c.id, year)
    if (used + asked > c.ownerNightsPerYear) throw new RuleError('OWNER_NIGHTS_EXCEEDED', `The contract allows ${c.ownerNightsPerYear} owner nights in ${year}; ${used} are taken or asked for, so ${Math.max(0, c.ownerNightsPerYear - used)} remain.`)
  }
}

/** What an owner sees of a stay on the calendar: dates and source, never the guest. */
export interface PortalCalendarSpan {
  id: string
  unitId: string
  unitCode: string
  from: IsoDate
  to: IsoDate
  kind: 'stay' | 'owner' | 'block'
  label: string
}

export function portalSpan(b: Pick<Booking, 'id' | 'unitId' | 'checkIn' | 'checkOut'>, unitCode: string, source: string): PortalCalendarSpan {
  return { id: b.id, unitId: b.unitId, unitCode, from: b.checkIn, to: b.checkOut, kind: 'stay', label: source }
}

/** Nights of a span inside a window, for the calendar bars. */
export const spanNights = (s: Pick<PortalCalendarSpan, 'from' | 'to'>, from: IsoDate, to: IsoDate) => Math.max(0, daysBetween(maxIso(s.from, from), minIso(s.to, to)))
