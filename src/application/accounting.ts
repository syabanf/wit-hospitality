import type { Action, Module, User } from '@/domain/access'
import { approvalProgress, canSignLevel, requiredLevels } from '@/domain/approval'
import { BOOKING_STATUS_LABEL } from '@/domain/booking'
import { findById, NotFoundError, RuleError } from '@/domain/errors'
import { awaitsApproval, TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { ratesOn, regencyOf, validateTaxSettings, type TaxSettingsInput } from '@/domain/tax'
import {
  balanceSheet,
  categoryAccount,
  generalLedger,
  GL,
  GL_TYPE_LABEL,
  incomeStatement,
  JOURNAL_SOURCE_LABEL,
  monthOf,
  monthsSince,
  partyBalances,
  payableBilled,
  PB1_CATEGORY,
  pb1Remittances,
  totalDebits,
  trialBalance,
  validateManualJournal,
  type GlAccount,
  type JournalEntry,
  type JournalSource,
  type ManualJournal,
  type ManualJournalInput,
} from '@/domain/journal'
import { periodLabel } from '@/domain/payroll'
import type { Catalog } from '@/domain/property'
import { PARTNER_KIND_LABEL } from '@/domain/serviceOrder'
import { CATEGORY_CODE, DEPARTMENT_LABEL, validateTransactionCode, type TransactionCodeInput } from '@/domain/transactionCode'
import type { Ports, TransactionAction } from './ports'
import type { ReportFilter } from './reports'
import type { ReportRow } from './views'

interface Deps {
  /** The signed-in user and what the permission matrix lets them do. */
  access: () => Promise<{ user: User; can: (module: Module, action: Action) => boolean }>
  allow: (module: Module, action: Action) => Promise<User>
  /** The catalog narrowed to the villas the signed-in user may see. */
  catalog: () => Promise<Catalog>
  /** Throws the field map when a validator found something. */
  check: (errors: Record<string, string | undefined>) => void
}

/** Where the record that wrote an entry opens. */
const SOURCE_HREF: Partial<Record<JournalSource, (id: string) => string>> = {
  transaction: (id) => `/finance/transactions/${id}`,
  transfer: (id) => `/finance/transactions/${id}`,
  payroll: (id) => `/payroll/${id}`,
  manual: (id) => `/accounting/manual/${id}`,
  folio: (id) => `/bookings/${id}/folio`,
  audit: (id) => `/bookings/${id}/folio`,
  charge: (id) => `/bookings/${id}/folio`,
  order: (id) => `/services/orders/${id}`,
  city_ledger: (id) => `/city-ledger/${id}`,
}
export const journalSourceHref = (e: Pick<JournalEntry, 'source' | 'sourceId'>) => SOURCE_HREF[e.source]?.(e.sourceId) ?? null

export interface ScopeFilter {
  locationId?: string
  villaId?: string
}

/** Accounting use cases: the chart, journals, ledgers, statements, manual journals and period close. */
export function createAccounting(ports: Ports, { access, allow, catalog, check }: Deps) {
  const today = () => ports.clock.today()

  /** The chart and the entries the user may see: a villa-scoped user sees their villas' entries only. */
  async function books(f: ScopeFilter = {}) {
    const user = await allow('finance', 'view')
    const [cat, chart, journals] = await Promise.all([catalog(), ports.ledger.chart(), ports.ledger.journals()])
    const restricted = user.locationIds.length > 0 || user.villaIds.length > 0
    const villaIds = new Set(cat.villas.filter((v) => (!f.locationId || v.locationId === f.locationId) && (!f.villaId || v.id === f.villaId)).map((v) => v.id))
    const narrowed = restricted || f.locationId || f.villaId
    const entries = narrowed ? journals.filter((e) => e.villaId !== null && villaIds.has(e.villaId)) : journals
    const villaName = (id: string | null) => (id ? (cat.villas.find((v) => v.id === id)?.name ?? id) : 'Portfolio')
    const accountName = (id: string) => {
      const a = chart.find((x) => x.id === id)
      return a ? `${a.code} ${a.name}` : id
    }
    return { cat, chart, entries, villaName, accountName, villas: cat.villas.map((v) => ({ id: v.id, name: v.name })), today: today() }
  }

  const describe = (e: JournalEntry, w: Awaited<ReturnType<typeof books>>) => ({
    ...e,
    villaName: w.villaName(e.villaId),
    sourceLabel: JOURNAL_SOURCE_LABEL[e.source],
    href: journalSourceHref(e),
    amount: totalDebits(e.lines),
    accounts: [...new Set(e.lines.map((l) => w.accountName(l.accountId)))].join(', '),
    lines: e.lines.map((l) => ({ ...l, account: findById(w.chart, l.accountId, 'ledger account') })),
  })
  type JournalView = ReturnType<typeof describe>

  async function manualWorld() {
    const [w, list, rules] = await Promise.all([books(), ports.ledger.manualJournals(), ports.finance.approvalRules()])
    const view = (m: ManualJournal) => {
      const levels = requiredLevels(rules, { kind: 'cash_out', villaId: m.villaId, amount: totalDebits(m.lines) })
      return { ...m, villaName: w.villaName(m.villaId), amount: totalDebits(m.lines), progress: approvalProgress(levels, m.approvals), lines: m.lines.map((l) => ({ ...l, account: findById(w.chart, l.accountId, 'ledger account') })) }
    }
    return { w, views: list.filter((m) => !m.villaId || w.villas.some((v) => v.id === m.villaId)).map(view), view }
  }

  /** Statement rows in the report registry's shape; amounts the reports print as money. */
  async function reportRows(slug: string, f: ReportFilter): Promise<ReportRow[]> {
    const w = await books({ locationId: f.locationId, villaId: f.villaId })
    const to = f.to ?? w.today
    const row = (section: string, a: GlAccount) => ({ section, code: a.code, account: a.name })
    if (slug === 'trial-balance') return trialBalance(w.chart, w.entries, { to }).rows.map((r) => ({ code: r.account.code, account: r.account.name, type: GL_TYPE_LABEL[r.account.type], debit: r.debit, credit: r.credit }))
    if (slug === 'income-statement') {
      const s = incomeStatement(w.chart, w.entries, { from: f.from, to })
      return [...s.revenue.map((l) => ({ ...row('Revenue', l.account), amount: l.amount })), ...s.expenses.map((l) => ({ ...row('Expenses', l.account), amount: -l.amount }))]
    }
    if (slug === 'balance-sheet') {
      const s = balanceSheet(w.chart, w.entries, { asOf: to })
      return [
        ...s.assets.map((l) => ({ ...row('Assets', l.account), assets: l.amount, claims: 0 })),
        ...s.liabilities.map((l) => ({ ...row('Liabilities', l.account), assets: 0, claims: l.amount })),
        ...s.equity.map((l) => ({ ...row('Equity', l.account), assets: 0, claims: l.amount })),
        { section: 'Equity', code: '', account: 'Profit this year', assets: 0, claims: s.yearEarnings },
      ]
    }
    const upTo = w.entries.filter((e) => e.date <= to)
    if (slug === 'stay-receivables') {
      const [bookings, guests] = await Promise.all([ports.booking.bookings(), ports.guest.guests()])
      const held = partyBalances(upTo, GL.deposits, 'bookingId')
      const owed = partyBalances(upTo, GL.receivable, 'bookingId')
      return bookings
        .filter((b) => held.has(b.id) || owed.has(b.id))
        .map((b) => {
          const d = held.get(b.id) ?? { debit: 0, credit: 0 }
          const r = owed.get(b.id) ?? { debit: 0, credit: 0 }
          const villa = w.cat.units.find((u) => u.id === b.unitId)?.villaId ?? null
          return { code: b.code, guest: guests.find((g) => g.id === b.guestId)?.name ?? '', villa: w.villaName(villa), status: BOOKING_STATUS_LABEL[b.status], checkOut: b.checkedOutOn ?? b.checkOut, held: d.credit - d.debit, billed: r.debit, settled: r.credit, receivable: r.debit - r.credit }
        })
        .sort((x, y) => y.receivable - x.receivable || y.held - x.held || x.code.localeCompare(y.code))
    }
    if (slug === 'revenue-codes') {
      const codes = await ports.ledger.transactionCodes()
      const inRange = w.entries.filter((e) => (!f.from || e.date >= f.from) && e.date <= to).flatMap((e) => e.lines.filter((l) => l.code))
      return codes
        .filter((c) => c.kind !== 'payment')
        .map((c) => {
          const mine = inRange.filter((l) => l.code === c.code)
          return { department: DEPARTMENT_LABEL[c.department], code: c.code, name: c.name, account: c.accountId ? w.accountName(c.accountId) : '', lines: mine.length, amount: mine.reduce((s, l) => s + l.credit - l.debit, 0) }
        })
        .filter((r) => r.lines > 0)
        .sort((a, b) => a.department.localeCompare(b.department) || a.code.localeCompare(b.code))
    }
    if (slug === 'pb1-regency' || slug === 'service-villa') {
      const [tax, transactions] = await Promise.all([ports.ledger.taxSettings(), ports.finance.transactions()])
      const months = monthsSince(f.from ?? to, to)
      if (slug === 'service-villa')
        return months.flatMap((month) =>
          w.cat.villas.map((v) => ({ month: periodLabel(month), villa: v.name, location: w.cat.location(v.locationId).name, service: payableBilled(w.entries, GL.servicePayable, month, new Set([v.id])) })).filter((r) => r.service !== 0),
        )
      return months.flatMap((month) =>
        pb1Remittances(month, w.entries, w.cat, tax, transactions)
          .filter((r) => r.amount !== 0 || r.entry)
          .map((r) => ({ month: periodLabel(month), regency: r.regency, locations: r.locationIds.map((id) => w.cat.location(id).name).join(', '), billed: r.amount, reference: r.reference, remittance: r.entry?.number ?? '', status: r.entry ? TRANSACTION_STATUS_LABEL[r.entry.status] : 'Not paid', remitted: r.entry?.status === 'posted' ? r.entry.amount : 0, owed: r.amount - (r.entry?.status === 'posted' ? r.entry.amount : 0) })),
      )
    }
    if (slug === 'partner-balances') {
      const partners = await ports.orders.partners()
      const owed = partyBalances(upTo, GL.partnerPayable, 'partnerId')
      return partners.map((p) => {
        const m = owed.get(p.id) ?? { debit: 0, credit: 0 }
        return { partner: p.name, kind: PARTNER_KIND_LABEL[p.kind], delivered: m.credit, paid: m.debit, owed: m.credit - m.debit }
      })
    }
    return w.entries
      .filter((e) => (!f.from || e.date >= f.from) && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
      .flatMap((e) => e.lines.map((l) => ({ date: e.date, number: e.number, memo: e.memo, source: `${JOURNAL_SOURCE_LABEL[e.source]} ${e.sourceNumber}`, villa: w.villaName(e.villaId), account: w.accountName(l.accountId), debit: l.debit, credit: l.credit })))
  }

  return {
    /** Every GL account with its balance today, the cash account behind it and the categories booked to it. */
    async chart() {
      const [w, map, categories, cashAccounts, codes] = await Promise.all([books(), ports.ledger.categoryAccounts(), ports.finance.categories(), ports.finance.accounts(), ports.ledger.transactionCodes()])
      const tb = trialBalance(w.chart, w.entries, { to: w.today })
      return w.chart.map((account) => {
        const r = tb.rows.find((x) => x.account.id === account.id)
        const net = r ? r.debit - r.credit : 0
        return {
          ...account,
          balance: account.normal === 'debit' ? net : -net,
          entries: w.entries.filter((e) => e.lines.some((l) => l.accountId === account.id)).length,
          cashAccount: cashAccounts.find((a) => a.id === account.cashAccountId)?.name ?? null,
          categories: categories.filter((c) => categoryAccount(map, c, codes) === account.id).map((c) => c.name),
          codes: codes.filter((c) => c.accountId === account.id).map((c) => c.code),
        }
      })
    },
    async journals() {
      const w = await books()
      return { views: w.entries.map((e) => describe(e, w)).sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number)), chart: w.chart, villas: w.villas, today: w.today }
    },
    async journal(id: string): Promise<JournalView> {
      const w = await books()
      return describe(findById(w.entries, id, 'journal entry'), w)
    },
    /** One account's general ledger; without an account, the first one in the chart. */
    async ledger(accountId: string | undefined, f: { from?: string; to?: string; villaId?: string }) {
      const w = await books({ villaId: f.villaId })
      const account = accountId ? findById(w.chart, accountId, 'ledger account') : w.chart[0]
      if (!account) throw new NotFoundError('ledger account', '')
      const gl = generalLedger(account, w.entries, f)
      return { account, chart: w.chart, villas: w.villas, today: w.today, opening: gl.opening, closing: gl.closing, lines: gl.lines.map((l) => ({ ...l, entry: describe(l.entry, w) })) }
    },
    async trialBalance(f: { to?: string; villaId?: string }) {
      const w = await books({ villaId: f.villaId })
      return { ...trialBalance(w.chart, w.entries, { to: f.to ?? w.today }), villas: w.villas, today: w.today }
    },
    async incomeStatement(f: { from?: string; to?: string; villaId?: string }) {
      const w = await books({ villaId: f.villaId })
      return { ...incomeStatement(w.chart, w.entries, { from: f.from, to: f.to ?? w.today }), villas: w.villas, today: w.today }
    },
    async balanceSheet(f: { asOf?: string; villaId?: string }) {
      const w = await books({ villaId: f.villaId })
      return { ...balanceSheet(w.chart, w.entries, { asOf: f.asOf ?? w.today }), villas: w.villas, today: w.today }
    },
    /**
     * The category to GL account mapping for the Categories page: every category but the guest
     * revenue ones, whose account comes from their transaction code (listed in `byCode`).
     */
    async categoryAccounts() {
      const [w, map, categories, codes] = await Promise.all([books(), ports.ledger.categoryAccounts(), ports.finance.categories(), ports.ledger.transactionCodes()])
      return {
        categories: categories.filter((c) => !CATEGORY_CODE[c.id]).map((c) => ({ ...c, accountId: categoryAccount(map, c, codes) })),
        byCode: categories.filter((c) => CATEGORY_CODE[c.id]).map((c) => ({ ...c, code: CATEGORY_CODE[c.id] ?? '' })),
        accounts: w.chart.filter((a) => !a.cashAccountId),
      }
    },
    async mapCategory(categoryId: string, accountId: string) {
      await allow('finance', 'edit')
      return ports.ledger.mapCategory(categoryId, accountId)
    },
    /** Every transaction code with its account, how many journal lines carry it and the revenue they booked this year. */
    async transactionCodes() {
      const [w, codes] = await Promise.all([books(), ports.ledger.transactionCodes()])
      const yearStart = `${w.today.slice(0, 4)}-01-01`
      const lines = w.entries.filter((e) => e.date >= yearStart).flatMap((e) => e.lines)
      return {
        codes: codes.map((c) => ({ ...c, account: c.accountId ? findById(w.chart, c.accountId, 'ledger account') : null, revenue: lines.filter((l) => l.code === c.code).reduce((s, l) => s + l.credit - l.debit, 0) })),
        accounts: w.chart.filter((a) => a.type === 'revenue'),
        today: w.today,
      }
    },
    async saveTransactionCode(id: string | null, input: TransactionCodeInput) {
      await allow('finance', 'edit')
      const [codes, chart] = await Promise.all([ports.ledger.transactionCodes(), ports.ledger.chart()])
      check(validateTransactionCode(input, codes, chart.filter((a) => a.type === 'revenue'), id ?? undefined))
      return id ? ports.ledger.updateTransactionCode(id, input) : ports.ledger.createTransactionCode(input)
    },
    async setTransactionCodeActive(id: string, active: boolean) {
      await allow('finance', 'edit')
      return ports.ledger.setTransactionCodeActive(id, active)
    },
    /**
     * The Tax settings page: the rates in force and every version, the codes that may carry tax,
     * each location's regency, and per closed month what PB1 it owes each regency with its remittance.
     */
    async taxSettings() {
      const [w, tax, codes, closes, transactions, accounts] = await Promise.all([books(), ports.ledger.taxSettings(), ports.ledger.transactionCodes(), ports.ledger.periodCloses(), ports.finance.transactions(), ports.finance.accounts()])
      return {
        tax,
        current: ratesOn(tax, w.today),
        codes: codes.filter((c) => c.kind === 'charge'),
        locations: w.cat.locations.map((l) => ({ ...l, regency: regencyOf(tax, l) })),
        months: [...closes].reverse().map((c) => ({ month: c.month, label: periodLabel(c.month), remittances: pb1Remittances(c.month, w.entries, w.cat, tax, transactions) })),
        accounts: accounts.filter((a) => a.kind === 'bank'),
        today: w.today,
      }
    },
    async saveTaxSettings(input: TaxSettingsInput) {
      await allow('finance', 'edit')
      const codes = await ports.ledger.transactionCodes()
      check(validateTaxSettings(input, codes.filter((c) => c.kind === 'charge').map((c) => c.code)))
      return ports.ledger.saveTaxSettings(input)
    },
    /**
     * Pay PB1: one cash-out per regency for what a closed month owes and has no remittance yet, from
     * the account picked, submitted through the approval chain like any cash-out.
     */
    async payPb1(month: string, accountId: string) {
      await allow('finance', 'post')
      const [w, tax, closes, transactions, accounts] = await Promise.all([books(), ports.ledger.taxSettings(), ports.ledger.periodCloses(), ports.finance.transactions(), ports.finance.accounts()])
      if (!closes.some((c) => c.month === month)) throw new RuleError('PERIOD_OPEN', `Close ${periodLabel(month)} before paying its PB1.`)
      const account = accounts.find((a) => a.id === accountId)
      if (!account) check({ accountId: 'Pick the account the PB1 is paid from.' })
      const due = pb1Remittances(month, w.entries, w.cat, tax, transactions).filter((r) => r.amount > 0 && !r.entry)
      if (due.length === 0) throw new RuleError('PB1_PAID', `PB1 for ${periodLabel(month)} has its remittance for every regency.`)
      const created = []
      for (const r of due)
        created.push(
          await ports.finance.createTransaction(
            { accountId, kind: 'cash_out', categoryId: PB1_CATEGORY, amount: r.amount, date: w.today, locationId: r.locationIds[0] ?? account?.locationId ?? '', villaId: null, unitId: null, bookingId: null, description: `PB1 remittance to ${r.regency} for ${periodLabel(month)}`, reference: r.reference, attachments: [] },
            true,
            'manual',
          ),
        )
      return created
    },
    async manualJournals() {
      return (await manualWorld()).views.sort((a, b) => b.createdOn.localeCompare(a.createdOn) || b.number.localeCompare(a.number))
    },
    /**
     * Manual journals in the approval queue, split like the cash inbox: what the signed-in person
     * signs or posts next (never their own), what waits for others, and what came back rejected.
     */
    async approvalQueue() {
      const a = await access()
      if (!a.can('finance', 'view')) return { mine: [], others: [], rejected: [] }
      const { views } = await manualWorld()
      const queue = views.filter(awaitsApproval).sort((x, y) => x.date.localeCompare(y.date))
      const canAct = (m: (typeof views)[number]) => (m.status === 'submitted' ? m.progress.next !== null && canSignLevel(a.user.role, m.progress.next) && m.createdById !== a.user.id : a.can('finance', 'post'))
      return { mine: queue.filter(canAct), others: queue.filter((m) => !canAct(m)), rejected: views.filter((m) => m.status === 'rejected') }
    },
    async manualJournal(id: string) {
      const m = await manualWorld()
      return findById(m.views, id, 'manual journal')
    },
    async manualOptions() {
      const w = await books()
      return { accounts: w.chart.filter((a) => !a.cashAccountId), villas: w.villas, today: w.today }
    },
    async createManualJournal(input: ManualJournalInput, submit: boolean) {
      await allow('finance', submit ? 'submit' : 'create')
      check(validateManualJournal(input, await ports.ledger.chart()))
      return ports.ledger.createManualJournal(input, submit)
    },
    async transitionManualJournal(id: string, to: TransactionAction, note = '') {
      if (to === 'approved' || to === 'rejected') await allow('approval', 'approve')
      if (to === 'posted') await allow('finance', 'post')
      if (to === 'submitted') await allow('finance', 'submit')
      if (to === 'rejected' && note.trim().length < 3) check({ note: 'Say why the journal is rejected.' })
      return ports.ledger.transitionManualJournal(id, to, note.trim())
    },
    /** Every month from the first entry to this one, with its activity and whether it is closed. */
    async periods() {
      const [w, closes, transactions, manual] = await Promise.all([books(), ports.ledger.periodCloses(), ports.finance.transactions(), ports.ledger.manualJournals()])
      const first = w.entries.reduce((min, e) => (e.date < min ? e.date : min), w.today)
      return monthsSince(first, w.today)
        .reverse()
        .map((month) => {
          const inMonth = w.entries.filter((e) => monthOf(e.date) === month)
          return {
            month,
            label: periodLabel(month),
            entries: inMonth.length,
            debits: inMonth.reduce((s, e) => s + totalDebits(e.lines), 0),
            pending: [...transactions, ...manual].filter((t) => awaitsApproval(t) && monthOf(t.date) === month).length,
            ended: month < monthOf(w.today),
            close: closes.find((c) => c.month === month) ?? null,
          }
        })
    },
    async closePeriod(month: string, note: string) {
      await allow('finance', 'post')
      return ports.ledger.closePeriod(month, note)
    },
    async reopenPeriod(month: string, reason: string) {
      await allow('finance', 'post')
      check({ reason: reason.trim().length < 3 ? 'Say why the month reopens.' : undefined })
      return ports.ledger.reopenPeriod(month, reason.trim())
    },
    reportRows,
  }
}

export type Accounting = ReturnType<typeof createAccounting>
