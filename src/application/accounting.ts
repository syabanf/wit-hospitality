import type { Action, Module, User } from '@/domain/access'
import { approvalProgress, requiredLevels } from '@/domain/approval'
import { findById, NotFoundError } from '@/domain/errors'
import { awaitsApproval } from '@/domain/finance'
import {
  balanceSheet,
  categoryAccount,
  generalLedger,
  GL_TYPE_LABEL,
  incomeStatement,
  JOURNAL_SOURCE_LABEL,
  monthOf,
  monthsSince,
  totalDebits,
  trialBalance,
  validateManualJournal,
  type GlAccount,
  type JournalEntry,
  type ManualJournal,
  type ManualJournalInput,
} from '@/domain/journal'
import { periodLabel } from '@/domain/payroll'
import type { Catalog } from '@/domain/property'
import type { Ports, TransactionAction } from './ports'
import type { ReportFilter } from './reports'
import type { ReportRow } from './views'

interface Deps {
  allow: (module: Module, action: Action) => Promise<User>
  /** The catalog narrowed to the villas the signed-in user may see. */
  catalog: () => Promise<Catalog>
  /** Throws the field map when a validator found something. */
  check: (errors: Record<string, string | undefined>) => void
}

/** Where the record that wrote an entry opens. */
export const journalSourceHref = (e: Pick<JournalEntry, 'source' | 'sourceId'>) =>
  e.source === 'transaction' || e.source === 'transfer' ? `/finance/transactions/${e.sourceId}` : e.source === 'payroll' ? `/payroll/${e.sourceId}` : e.source === 'manual' ? `/accounting/manual/${e.sourceId}` : null

export interface ScopeFilter {
  locationId?: string
  villaId?: string
}

/** Accounting use cases: the chart, journals, ledgers, statements, manual journals and period close. */
export function createAccounting(ports: Ports, { allow, catalog, check }: Deps) {
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
    return w.entries
      .filter((e) => (!f.from || e.date >= f.from) && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
      .flatMap((e) => e.lines.map((l) => ({ date: e.date, number: e.number, memo: e.memo, source: `${JOURNAL_SOURCE_LABEL[e.source]} ${e.sourceNumber}`, villa: w.villaName(e.villaId), account: w.accountName(l.accountId), debit: l.debit, credit: l.credit })))
  }

  return {
    /** Every GL account with its balance today, the cash account behind it and the categories booked to it. */
    async chart() {
      const [w, map, categories, cashAccounts] = await Promise.all([books(), ports.ledger.categoryAccounts(), ports.finance.categories(), ports.finance.accounts()])
      const tb = trialBalance(w.chart, w.entries, { to: w.today })
      return w.chart.map((account) => {
        const r = tb.rows.find((x) => x.account.id === account.id)
        const net = r ? r.debit - r.credit : 0
        return {
          ...account,
          balance: account.normal === 'debit' ? net : -net,
          entries: w.entries.filter((e) => e.lines.some((l) => l.accountId === account.id)).length,
          cashAccount: cashAccounts.find((a) => a.id === account.cashAccountId)?.name ?? null,
          categories: categories.filter((c) => categoryAccount(map, c) === account.id).map((c) => c.name),
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
    /** The category to GL account mapping for the Categories page. */
    async categoryAccounts() {
      const [w, map, categories] = await Promise.all([books(), ports.ledger.categoryAccounts(), ports.finance.categories()])
      return { categories: categories.map((c) => ({ ...c, accountId: categoryAccount(map, c) })), accounts: w.chart.filter((a) => !a.cashAccountId) }
    },
    async mapCategory(categoryId: string, accountId: string) {
      await allow('finance', 'edit')
      return ports.ledger.mapCategory(categoryId, accountId)
    },
    async manualJournals() {
      return (await manualWorld()).views.sort((a, b) => b.createdOn.localeCompare(a.createdOn) || b.number.localeCompare(a.number))
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
