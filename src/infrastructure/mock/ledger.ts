import type { LedgerPort } from '@/application/ports'
import { ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import { approvalProgress, canSignLevel, requiredLevels } from '@/domain/approval'
import { findById, RuleError } from '@/domain/errors'
import { canTransitionTransaction, type CashAccount, type Transaction, type TransactionEvent } from '@/domain/finance'
import { assertBalanced, assertClosable, assertOpenPeriod, chartOfAccounts, journalFor, manualJournalEntry, numbered, openingJournals, totalDebits, validateManualJournal, validateMapping, type JournalDraft, type ManualJournal } from '@/domain/journal'
import type { MockState } from './state'

/** What the ledger borrows from the mock: the tables and the session-aware helpers. */
export interface LedgerDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  copy: <T>(v: T) => T
  today: () => string
  seq: (key: string) => number
  user: () => User
  event: (kind: TransactionEvent['kind'], note?: string) => TransactionEvent
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
}

/** The books behind the cash ledger: every posting writes its journal entry here, and closed months refuse postings. */
export function createLedger({ s, later, copy, today, seq, user, event, refuse, log }: LedgerDeps) {
  const chart = () => chartOfAccounts(s.cashAccounts)
  const write = (draft: JournalDraft) => {
    s.journals.push(numbered(draft, seq('journal'), today(), user().name))
  }
  const assertOpen = (date: string) => assertOpenPeriod(s.periodCloses, date)

  /** After a cash entry posts; a transfer writes once for both halves, a salary payment writes the payroll entry. */
  function recordPosting(t: Transaction) {
    const draft = journalFor(t, { transactions: s.transactions, periods: s.periods, map: s.categoryAccounts, categories: s.categories })
    if (!s.journals.some((j) => j.source === draft.source && j.sourceId === draft.sourceId)) write(draft)
  }

  /** A new cash account's opening balance against owner equity. */
  const recordOpening = (account: CashAccount) => openingJournals([account]).forEach(write)

  const port: LedgerPort = {
    chart: () => later(chart),
    categoryAccounts: () => later(() => copy(s.categoryAccounts)),
    mapCategory: (categoryId, accountId) =>
      later(() => {
        const category = findById(s.categories, categoryId, 'category')
        validateMapping(accountId, chart())
        const before = s.categoryAccounts[categoryId] ?? null
        s.categoryAccounts[categoryId] = accountId
        log('update', 'category', categoryId, `${category.name} now books to ${chart().find((a) => a.id === accountId)?.name}`, { accountId: before }, { accountId })
        return copy(s.categoryAccounts)
      }),
    journals: () => later(() => copy(s.journals)),
    manualJournals: () => later(() => copy(s.manualJournals)),
    createManualJournal: (input, submit) =>
      later(() => {
        refuse(validateManualJournal(input, chart()))
        const lines = input.lines.filter((l) => l.debit > 0 || l.credit > 0)
        assertBalanced(lines)
        const me = user()
        const n = seq('manualJournal')
        const m: ManualJournal = {
          ...input,
          memo: input.memo.trim(),
          lines,
          attachments: [...input.attachments],
          id: `mj-${n}`,
          number: `MJ-${String(n).padStart(4, '0')}`,
          status: submit ? 'submitted' : 'draft',
          approvals: [],
          history: submit ? [event('created'), event('submitted')] : [event('created')],
          rejectionReason: null,
          journalId: null,
          createdBy: me.name,
          createdById: me.id,
          createdOn: today(),
        }
        s.manualJournals.push(m)
        log('create', 'manual-journal', m.number, `${submit ? 'Submitted' : 'Drafted'} ${m.number}, ${m.memo}`, null, { amount: totalDebits(lines) })
        return copy(m)
      }),
    transitionManualJournal: (id, to, note = '') =>
      later(() => {
        const m = findById(s.manualJournals, id, 'manual journal')
        const me = user()
        if (!canTransitionTransaction(m, to)) throw new RuleError(m.status === 'posted' ? 'TRANSACTION_ALREADY_POSTED' : 'TRANSACTION_INVALID_STATE', `A ${m.status} journal cannot become ${to}.`)
        const before = m.status
        // A manual journal signs like a cash-out of its total under the same rules.
        const levels = requiredLevels(s.approvalRules, { kind: 'cash_out', villaId: m.villaId, amount: totalDebits(m.lines) })
        if (to === 'submitted') {
          m.history = [...m.history, event(before === 'rejected' ? 'resubmitted' : 'submitted', note)]
          m.approvals = []
          m.rejectionReason = null
          m.status = 'submitted'
        } else if (to === 'approved') {
          const progress = approvalProgress(levels, m.approvals)
          if (!progress.next) throw new RuleError('TRANSACTION_INVALID_STATE', `${m.number} already has every signature.`)
          if (m.createdById === me.id) throw new RuleError('APPROVAL_SELF', 'The person who wrote a journal cannot approve it.')
          if (!canSignLevel(me.role, progress.next)) throw new RuleError('APPROVAL_ROLE', `Level ${progress.done + 1} of ${progress.levels.length} needs ${ROLE_LABEL[progress.next]}; you are ${ROLE_LABEL[me.role]}.`)
          if (m.approvals.some((a) => a.by === me.name)) throw new RuleError('APPROVAL_SELF', 'You have already signed this journal.')
          m.approvals = [...m.approvals, { level: progress.done + 1, role: progress.next, by: me.name, on: today(), note: note.trim() }]
          const after = approvalProgress(levels, m.approvals)
          m.history = [...m.history, event('approved', after.complete ? 'All levels signed' : `Level ${after.done} of ${after.levels.length}`)]
          if (after.complete) m.status = 'approved'
        } else if (to === 'rejected') {
          if (note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the journal is rejected.')
          if (m.createdById === me.id) throw new RuleError('APPROVAL_SELF', 'The person who wrote a journal cannot reject it.')
          m.status = 'rejected'
          m.rejectionReason = note.trim()
          m.history = [...m.history, event('rejected', note.trim())]
        } else {
          assertOpen(m.date)
          write(manualJournalEntry(m))
          m.journalId = s.journals.at(-1)?.id ?? null
          m.status = 'posted'
          m.history = [...m.history, event('posted', note)]
        }
        log(to === 'approved' ? 'approve' : to === 'rejected' ? 'reject' : 'status', 'manual-journal', m.number, `${to === 'approved' && m.status !== 'approved' ? 'Signed' : to.charAt(0).toUpperCase() + to.slice(1)} ${m.number}, ${m.memo}`, { status: before }, { status: m.status })
        return copy(m)
      }),
    periodCloses: () => later(() => copy(s.periodCloses)),
    closePeriod: (month, note) =>
      later(() => {
        assertClosable(month, today(), s.periodCloses, [...s.transactions, ...s.manualJournals])
        const close = { month, closedOn: today(), closedBy: user().name, note: note.trim() }
        s.periodCloses.push(close)
        s.periodCloses.sort((a, b) => a.month.localeCompare(b.month))
        log('status', 'period', month, `Closed the books for ${month}`, { closed: false }, { closed: true })
        return copy(close)
      }),
    reopenPeriod: (month, reason) =>
      later(() => {
        if (!s.periodCloses.some((c) => c.month === month)) throw new RuleError('PERIOD_OPEN', `${month} is not closed.`)
        if (reason.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the month reopens.')
        s.periodCloses = s.periodCloses.filter((c) => c.month !== month)
        log('status', 'period', month, `Reopened the books for ${month}: ${reason.trim()}`, { closed: true }, { closed: false })
      }),
  }

  return { port, assertOpen, recordPosting, recordOpening }
}
