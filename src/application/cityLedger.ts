import type { Action, Module, User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import {
  accountBalance,
  agingOf,
  BILLING_INSTRUCTIONS,
  CITY_AGING_BUCKETS,
  CITY_LEDGER_KIND_LABEL,
  daysOverdue,
  INVOICE_STATE_LABEL,
  invoiceSettlement,
  invoiceState,
  ledgerItems,
  openTransfers,
  partsTotal,
  runningLedger,
  statusRules,
  transferParts,
  unapplied,
  validateCityLedgerAccount,
  validateCityLedgerPayment,
  validateWriteOff,
  type BillingInstruction,
  type CityLedgerAccount,
  type CityLedgerAccountInput,
  type CityLedgerInvoice,
  type CityLedgerPaymentInput,
  type LedgerSources,
} from '@/domain/cityLedger'
import { findById } from '@/domain/errors'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import type { GuestFolio } from '@/domain/folio'
import { liveStay } from '@/domain/group'
import { PAYMENT_METHOD_LABEL } from '@/domain/payment'
import { payState } from '@/domain/serviceOrder'
import { stayTax } from '@/domain/tax'
import { addDays, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { ReportFilter } from './reports'
import type { BookingView, ReportRow } from './views'

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ can: (module: Module, action: Action) => boolean }>
  check: (errors: Record<string, string | undefined>) => void
  /** The stay with the folio check-out settles from. */
  folio: (bookingId: string) => Promise<{ booking: BookingView; folio: GuestFolio }>
}

export const CITY_LEDGER_REPORTS = new Set(['cl-aging', 'cl-invoices', 'cl-payments', 'cl-commission'])

/** Invoices this many days past due show in the bell and on the dashboard. */
export const OVERDUE_ALERT_DAYS = 30

const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)

/**
 * City ledger use cases: accounts, transfers off the folio at the desk, invoices, payments,
 * write-offs, the account ledger and statement, and the four city ledger reports.
 */
export function createCityLedgerServices({ ports, today, allow, access, check, folio }: Deps) {
  async function books() {
    const [accounts, transfers, invoices, payments, writeOffs, transactions, manual, bookings, groups, tax] = await Promise.all([
      ports.cityLedger.accounts(),
      ports.cityLedger.transfers(),
      ports.cityLedger.invoices(),
      ports.cityLedger.payments(),
      ports.cityLedger.writeOffs(),
      ports.finance.transactions(),
      ports.ledger.manualJournals(),
      ports.booking.bookings(),
      ports.groups.groups(),
      ports.ledger.taxSettings(),
    ])
    const now = today()
    const txOf = (id: string) => transactions.find((t) => t.id === id)
    const src: LedgerSources = {
      transfers,
      invoices,
      payments,
      writeOffs,
      bookingCode: (id) => bookings.find((b) => b.id === id)?.code ?? id,
      ...statusRules((id) => txOf(id)?.status, (id) => manual.find((m) => m.id === id)?.status),
    }
    const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? id
    const invoiceView = (inv: CityLedgerInvoice) => {
      const s = invoiceSettlement(inv, src)
      const state = invoiceState(inv, s, now)
      return { ...inv, accountName: accountName(inv.accountId), ...s, state, stateLabel: INVOICE_STATE_LABEL[state], daysOverdue: s.open > 0 ? daysOverdue(inv.dueOn, now) : 0 }
    }
    const invoiceViews = invoices.map(invoiceView).sort((a, b) => b.issuedOn.localeCompare(a.issuedOn) || b.number.localeCompare(a.number))
    const billedTo = (b: Booking) => b.cityLedger ?? (b.bookingGroupId ? groups.find((g) => g.id === b.bookingGroupId)?.cityLedger : undefined)
    const transferredOf = (bookingId: string) => sum(transfers.filter((p) => p.bookingId === bookingId).map((p) => p.amount))
    /** Stays booked to the account that have not moved over yet, at what they come to. */
    const coming = (accountId: string) => sum(bookings.filter((b) => liveStay(b) && billedTo(b)?.accountId === accountId).map((b) => Math.max(0, stayTax(b, tax).total - transferredOf(b.id))))
    const summary = (a: CityLedgerAccount) => {
      const balance = accountBalance(a.id, src)
      const mine = invoiceViews.filter((i) => i.accountId === a.id)
      const uninvoiced = sum(openTransfers(a.id, transfers, invoices).map((p) => p.amount))
      const credit = sum(payments.filter((p) => p.accountId === a.id && src.paymentPosted(p)).map(unapplied))
      const used = balance + coming(a.id)
      return {
        ...a,
        kindLabel: CITY_LEDGER_KIND_LABEL[a.kind],
        balance,
        uninvoiced,
        credit,
        overdue: sum(mine.filter((i) => i.state === 'overdue').map((i) => i.open)),
        openInvoices: mine.filter((i) => i.open > 0).length,
        used,
        usedPct: a.creditLimit > 0 ? used / a.creditLimit : 0,
        available: a.creditLimit - used,
        aging: agingOf(mine, uninvoiced, credit, now),
      }
    }
    return { accounts, transfers, invoices, payments, writeOffs, transactions, bookings, src, invoiceViews, summary, txOf, accountName, now }
  }
  type Books = Awaited<ReturnType<typeof books>>

  const paymentView = (w: Books) => (p: Books['payments'][number]) => {
    const t = w.txOf(p.transactionId)
    return { ...p, accountName: w.accountName(p.accountId), transaction: t ?? null, statusLabel: t ? TRANSACTION_STATUS_LABEL[t.status] : '', posted: w.src.paymentPosted(p), credit: unapplied(p), invoiceNumbers: p.allocations.map((a) => w.invoices.find((i) => i.id === a.invoiceId)?.number ?? '').join(', ') }
  }

  async function reportRows(slug: string, f: ReportFilter & { from: string; to: string }): Promise<ReportRow[]> {
    await allow('finance', 'view')
    const w = await books()
    const inRange = (d: IsoDate) => d >= f.from && d <= f.to
    if (slug === 'cl-aging')
      return w.accounts.map((a) => {
        const s = w.summary(a)
        return { account: a.name, kind: s.kindLabel, terms: a.termsDays, limit: a.creditLimit, ...s.aging, balance: s.balance }
      })
    if (slug === 'cl-invoices')
      return w.invoiceViews.filter((i) => inRange(i.issuedOn)).map((i) => ({ number: i.number, account: i.accountName, issuedOn: i.issuedOn, dueOn: i.dueOn, gross: i.gross, service: i.service, pb1: i.pb1, commission: -i.commission, net: i.net, paid: i.paid + i.writtenOff, open: i.open, state: i.stateLabel }))
    if (slug === 'cl-payments')
      return w.payments
        .filter((p) => inRange(p.date))
        .map(paymentView(w))
        .map((p) => ({ date: p.date, number: p.number, account: p.accountName, method: PAYMENT_METHOD_LABEL[p.method], reference: p.reference, entry: p.transaction?.number ?? '', status: p.statusLabel, amount: p.amount, allocated: p.amount - p.credit, credit: p.credit }))
    return w.invoiceViews
      .filter((i) => i.commission > 0 && inRange(i.issuedOn))
      .map((i) => ({ account: i.accountName, number: i.number, issuedOn: i.issuedOn, charges: i.gross - i.service - i.pb1, pct: i.commissionPct / 100, commission: i.commission }))
  }

  return {
    /** Every account with its balance, what is overdue, the credit used and the aging. */
    async overview() {
      await allow('finance', 'view')
      const [w, villas] = await Promise.all([books(), ports.property.villas()])
      const rows = w.accounts.map(w.summary).sort((a, b) => a.code.localeCompare(b.code))
      return { rows, villas: villas.map((v) => ({ id: v.id, name: v.name })), totals: Object.fromEntries(CITY_AGING_BUCKETS.map((k) => [k, sum(rows.map((r) => r.aging[k]))])) as Record<(typeof CITY_AGING_BUCKETS)[number], number>, balance: sum(rows.map((r) => r.balance)), overdue: sum(rows.map((r) => r.overdue)), today: w.now }
    },
    /** One account: the ledger with its running balance, invoices, payments, write-offs, transfers still to invoice and the aging. */
    async account(id: string) {
      await allow('finance', 'view')
      const [w, cashAccounts, villas] = await Promise.all([books(), ports.finance.accounts(), ports.property.villas()])
      const a = findById(w.accounts, id, 'city ledger account')
      const open = openTransfers(a.id, w.transfers, w.invoices)
      return {
        account: w.summary(a),
        ledger: runningLedger(ledgerItems(a.id, w.src)),
        invoices: w.invoiceViews.filter((i) => i.accountId === a.id),
        payments: w.payments.filter((p) => p.accountId === a.id).map(paymentView(w)).sort((x, y) => y.date.localeCompare(x.date)),
        writeOffs: w.writeOffs.filter((x) => x.accountId === a.id).map((x) => ({ ...x, invoiceNumber: w.invoices.find((i) => i.id === x.invoiceId)?.number ?? '', posted: w.src.writeOffPosted(x), live: w.src.writeOffLive(x) })),
        uninvoiced: [...new Set(open.map((p) => p.bookingId))].map((bookingId) => {
          const mine = open.filter((p) => p.bookingId === bookingId)
          return { bookingId, code: w.src.bookingCode(bookingId), date: mine.reduce((d, p) => (p.date > d ? p.date : d), ''), amount: sum(mine.map((p) => p.amount)) }
        }),
        cashAccounts: cashAccounts.filter((c) => c.kind === 'bank' || c.kind === 'cashbox').map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
        villas: villas.map((v) => ({ id: v.id, name: v.name })),
        today: w.now,
      }
    },
    /** The statement of account for a period: opening balance, every item with the running balance, closing balance, aging and open invoices. */
    async statement(id: string, range: { from?: IsoDate; to?: IsoDate } = {}) {
      await allow('finance', 'view')
      const w = await books()
      const a = findById(w.accounts, id, 'city ledger account')
      const from = range.from ?? addDays(w.now, -89)
      const to = range.to ?? w.now
      const all = runningLedger(ledgerItems(a.id, w.src)).lines
      const before = all.filter((l) => l.date < from)
      const opening = before.at(-1)?.balance ?? 0
      const lines = all.filter((l) => l.date >= from && l.date <= to)
      return { account: w.summary(a), from, to, opening, lines, closing: lines.at(-1)?.balance ?? opening, openInvoices: w.invoiceViews.filter((i) => i.accountId === a.id && i.open > 0), today: w.now }
    },
    async invoice(id: string) {
      await allow('finance', 'view')
      const w = await books()
      const inv = findById(w.invoiceViews, id, 'invoice')
      return { invoice: inv, account: w.summary(findById(w.accounts, inv.accountId, 'city ledger account')), payments: w.payments.filter((p) => p.allocations.some((x) => x.invoiceId === id)).map(paymentView(w)), today: w.now }
    },
    async saveAccount(id: string | null, input: CityLedgerAccountInput) {
      await allow('finance', id ? 'edit' : 'create')
      check(validateCityLedgerAccount(input, await ports.cityLedger.accounts(), id ?? undefined))
      return ports.cityLedger.saveAccount(id, input)
    },
    /** Accounts a new direct booking or group may bill, with what is left of each one's credit. */
    async bookingOptions() {
      const a = await access()
      if (!a.can('booking', 'create')) return { accounts: [], mayOverride: false }
      const w = await books()
      return { accounts: w.accounts.filter((x) => x.active).map((x) => ({ id: x.id, code: x.code, name: x.name, kind: x.kind, villaIds: x.villaIds, creditLimit: x.creditLimit, available: w.summary(x).available })), mayOverride: a.can('finance', 'approve') || a.can('booking', 'approve') }
    },
    /** What the desk may transfer for a stay in house: the accounts open to its villa, the billing it was booked with, and the amount under each instruction. */
    async transferOptions(bookingId: string) {
      const a = await access()
      const [{ booking: b, folio: f }, accounts, orders, payments, groups] = await Promise.all([folio(bookingId), ports.cityLedger.accounts(), ports.orders.orders(), ports.payment.payments(), ports.groups.groups()])
      const waiting = new Set(orders.filter((o) => o.bookingId === b.id && payState(o, payments) === 'pending').map((o) => o.id))
      const preview = Object.fromEntries(BILLING_INSTRUCTIONS.map((k) => [k, partsTotal(transferParts(f, orders, k, waiting))])) as Record<BillingInstruction, number>
      const group = b.bookingGroupId ? groups.find((g) => g.id === b.bookingGroupId) : undefined
      return {
        allowed: a.can('booking', 'edit') && b.status === 'checked_in' && b.source === 'direct',
        accounts: accounts.filter((x) => x.active && (x.villaIds.length === 0 || x.villaIds.includes(b.place.villa.id))).map((x) => ({ id: x.id, code: x.code, name: x.name })),
        billing: b.cityLedger ?? group?.cityLedger ?? null,
        preview,
        transferred: (await ports.cityLedger.transfers()).filter((p) => p.bookingId === b.id).reduce((s, p) => s + p.amount, 0),
      }
    },
    async transfer(bookingId: string, input: { accountId: string; instruction: BillingInstruction }) {
      await allow('booking', 'edit')
      check({ accountId: input.accountId ? undefined : 'Pick the account the bill goes to.' })
      return ports.cityLedger.transfer(bookingId, input)
    },
    async transferGroup(groupId: string, accountId: string) {
      await allow('booking', 'edit')
      check({ accountId: accountId ? undefined : 'Pick the account the bill goes to.' })
      return ports.cityLedger.transferGroup(groupId, accountId)
    },
    async issueInvoice(accountId: string, through: IsoDate) {
      await allow('finance', 'create')
      check({ through: /^\d{4}-\d{2}-\d{2}$/.test(through) ? undefined : 'Pick the last transfer date to include.' })
      return ports.cityLedger.issueInvoice(accountId, through)
    },
    async sendInvoice(invoiceId: string) {
      await allow('finance', 'edit')
      return ports.cityLedger.sendInvoice(invoiceId)
    },
    async recordPayment(input: CityLedgerPaymentInput) {
      await allow('finance', 'submit')
      check(validateCityLedgerPayment(input))
      return ports.cityLedger.recordPayment(input)
    },
    async applyCredit(accountId: string) {
      await allow('finance', 'edit')
      return ports.cityLedger.applyCredit(accountId)
    },
    async writeOff(input: { accountId: string; invoiceId: string; amount: number; reason: string }) {
      await allow('finance', 'submit')
      check(validateWriteOff(input, Number.MAX_SAFE_INTEGER))
      return ports.cityLedger.writeOff(input)
    },
    /** Invoices more than 30 days past due, for the bell; empty for someone who cannot see finance. */
    async overdue() {
      const a = await access()
      if (!a.can('finance', 'view')) return []
      const w = await books()
      return w.invoiceViews.filter((i) => i.open > 0 && i.daysOverdue > OVERDUE_ALERT_DAYS).sort((x, y) => y.daysOverdue - x.daysOverdue)
    },
    reportRows,
  }
}

export type CityLedgerServices = ReturnType<typeof createCityLedgerServices>
