import type { CityLedgerPort } from '@/application/ports'
import { can, type AuditAction, type User } from '@/domain/access'
import type { Booking } from '@/domain/booking'
import {
  accountBalance,
  allocatable,
  assertBookable,
  assertWriteOffLimit,
  creditCheck,
  dueDate,
  invoiceFigures,
  invoiceNumber,
  oldestFirst,
  openTransfers,
  partsTotal,
  statusRules,
  transferParts,
  unapplied,
  validateCityLedgerAccount,
  validateCityLedgerPayment,
  validateWriteOff,
  BILLING_INSTRUCTION_LABEL,
  type BillingInstruction,
  type CityLedgerAccount,
  type CityLedgerBilling,
  type CityLedgerBillingInput,
  type CityLedgerInvoice,
  type CityLedgerPayment,
  type LedgerSources,
  type TransferPart,
} from '@/domain/cityLedger'
import { findById, RuleError } from '@/domain/errors'
import type { Transaction } from '@/domain/finance'
import type { FolioPosting, GuestFolio } from '@/domain/folio'
import { liveStay } from '@/domain/group'
import { GL, type CommissionSource, type ManualJournal, type ManualJournalInput } from '@/domain/journal'
import { renderTemplate, type Message } from '@/domain/messaging'
import { payState } from '@/domain/serviceOrder'
import { CITY_LEDGER_CODE } from '@/domain/transactionCode'
import type { MockState } from './state'

/** The mock API's helpers the city ledger reuses, so its money runs through the same folio, ledger and approval paths. */
export interface CityLedgerDeps {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  atomically: <T>(change: () => T) => T
  copy: <T>(v: T) => T
  seq: (key: string) => number
  user: () => User
  today: () => string
  clockNow: () => string
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
  refuse: (errors: Record<string, string | undefined>) => void
  /** The stay's folio; `whole` keeps a master-billed group's room lines on it. */
  folioOf: (b: Booking, whole?: boolean) => GuestFolio
  /** What the guest pays for the room, service and PB1 included. */
  stayTotal: (b: Booking) => number
  pendingSettle: (bookingId: string) => unknown
  syncBooking: (bookingId: string) => void
  newTransaction: (fields: Omit<Transaction, 'id' | 'number' | 'status' | 'approvals' | 'history' | 'rejectionReason' | 'reversalOf' | 'reversedBy' | 'createdBy' | 'createdById' | 'createdOn'>, submit: boolean) => Transaction
  ledger: {
    recordTransfer: (b: Booking, posting: Pick<FolioPosting, 'amount' | 'date' | 'description' | 'cityLedger'>) => void
    recordCommission: (inv: CommissionSource) => string | null
    newManualJournal: (input: ManualJournalInput, submit: boolean) => ManualJournal
  }
}

const rupiah = (v: number) => `Rp ${v.toLocaleString('id-ID')}`

export function createCityLedger(d: CityLedgerDeps) {
  const { s, later, atomically, copy, seq, user, today, clockNow, log, refuse } = d
  const account = (id: string) => findById(s.cityLedgerAccounts, id, 'city ledger account')
  const groupOf = (b: Booking) => (b.bookingGroupId ? s.bookingGroups.find((g) => g.id === b.bookingGroupId) : undefined)
  const billedTo = (b: Booking) => b.cityLedger ?? groupOf(b)?.cityLedger

  const sources = (): LedgerSources => ({
    transfers: s.folioPostings,
    invoices: s.cityLedgerInvoices,
    payments: s.cityLedgerPayments,
    writeOffs: s.cityLedgerWriteOffs,
    bookingCode: (id) => s.bookings.find((b) => b.id === id)?.code ?? id,
    ...statusRules((id) => s.transactions.find((t) => t.id === id)?.status, (id) => s.manualJournals.find((m) => m.id === id)?.status),
  })

  /** What the account has used of its line: its balance, and the stays booked to it that have not moved over yet. */
  function creditUsed(accountId: string) {
    const transferred = (b: Booking) => s.folioPostings.filter((p) => p.bookingId === b.id && p.kind === 'transfer').reduce((sum, p) => sum + p.amount, 0)
    const coming = s.bookings.filter((b) => liveStay(b) && billedTo(b)?.accountId === accountId).reduce((sum, b) => sum + Math.max(0, d.stayTotal(b) - transferred(b)), 0)
    return accountBalance(accountId, sources()) + coming
  }

  /**
   * The billing a new direct stay or group carries: the account must be open for its villas, and the
   * stays may not take it past its credit limit unless finance or a manager overrides with a reason.
   */
  function billing(input: CityLedgerBillingInput | null | undefined, stays: readonly Booking[], source: string): CityLedgerBilling | undefined {
    if (!input?.accountId) return undefined
    if (source !== 'direct') throw new RuleError('CITY_LEDGER_CHANNEL', 'Only a direct stay bills a company or agent; Airbnb collects its own stays.')
    const a = account(input.accountId)
    for (const b of stays) {
      const villa = s.catalog().place(b.unitId).villa
      assertBookable(a, villa.id, villa.name)
    }
    const me = user()
    const may = can(s.permissions, me.role, 'finance', 'approve') || can(s.permissions, me.role, 'booking', 'approve')
    const override = creditCheck(a, creditUsed(a.id), stays.reduce((sum, b) => sum + d.stayTotal(b), 0), { may, reason: input.overrideReason ?? '', by: me.name })
    if (override) log('update', 'city-ledger-account', a.code, `Booked past the credit limit of ${a.code} ${a.name}: ${override.reason}`, null, { stays: stays.map((b) => b.code).join(', ') })
    return { accountId: a.id, instruction: input.instruction, override }
  }

  /** Posts each part of a transfer on its stay: the folio credit and the journal moving it off the guest receivable. */
  function post(b: Booking, a: CityLedgerAccount, instruction: BillingInstruction, parts: readonly TransferPart[]) {
    const me = user()
    return parts.map((part) => {
      const n = seq('folio')
      const posting: FolioPosting = { id: `fp-${n}`, bookingId: b.id, kind: 'transfer', code: CITY_LEDGER_CODE, description: `Transfer to city ledger ${a.code} ${a.name}`, amount: part.amount, date: today(), part: part.part, lineId: null, orderId: part.orderId, postedBy: me.name, postedById: me.id, postedAt: clockNow(), approvedBy: null, transactionId: null, cityLedger: { accountId: a.id, instruction, service: part.service, pb1: part.pb1 } }
      d.ledger.recordTransfer(b, posting)
      s.folioPostings.push(posting)
      return posting
    })
  }

  function assertTransferable(b: Booking, a: CityLedgerAccount) {
    if (b.source !== 'direct') throw new RuleError('CITY_LEDGER_CHANNEL', `${b.code} came through Airbnb, which collects the stay; only a direct stay moves to the city ledger.`)
    if (d.pendingSettle(b.id)) throw new RuleError('SETTLEMENT_PENDING', `${b.code} has a check-out link waiting for the guest; cancel it before moving the bill.`)
    const villa = s.catalog().place(b.unitId).villa
    assertBookable(a, villa.id, villa.name)
  }

  const invoicesOf = (accountId: string) => s.cityLedgerInvoices.filter((i) => i.accountId === accountId)
  const settleSources = () => ({ ...sources(), payments: s.cityLedgerPayments, writeOffs: s.cityLedgerWriteOffs })

  const port: CityLedgerPort = {
    accounts: () => later(() => copy(s.cityLedgerAccounts)),
    saveAccount: (id, input) =>
      later(() => {
        refuse(validateCityLedgerAccount(input, s.cityLedgerAccounts, id ?? undefined))
        const fields = { ...input, name: input.name.trim(), contact: input.contact.trim(), billingEmail: input.billingEmail.trim(), phone: input.phone.trim(), address: input.address.trim(), npwp: input.npwp.trim(), villaIds: [...input.villaIds] }
        if (id) {
          const a = account(id)
          const before = { creditLimit: a.creditLimit, termsDays: a.termsDays, active: a.active }
          Object.assign(a, fields)
          log('update', 'city-ledger-account', a.code, `Edited city ledger account ${a.code} ${a.name}`, before, { creditLimit: a.creditLimit, termsDays: a.termsDays, active: a.active })
          return copy(a)
        }
        const n = s.cityLedgerAccounts.length + 1
        const a: CityLedgerAccount = { ...fields, id: `cl-${seq('entity')}`, code: `CL-${String(n).padStart(3, '0')}`, createdOn: today() }
        s.cityLedgerAccounts.push(a)
        log('create', 'city-ledger-account', a.code, `Opened city ledger account ${a.code} ${a.name}`, null, { creditLimit: a.creditLimit, termsDays: a.termsDays })
        return copy(a)
      }),
    transfers: () => later(() => copy(s.folioPostings.filter((p) => p.kind === 'transfer'))),
    transfer: (bookingId, input) =>
      later(() =>
        atomically(() => {
          const b = findById(s.bookings, bookingId, 'booking')
          if (b.status !== 'checked_in') throw new RuleError('BOOKING_INVALID_STATE', `${b.code} is not in house; transfer the bill during the stay or at check-out.`)
          const a = account(input.accountId)
          assertTransferable(b, a)
          // Orders waiting on a payment link stay with the guest until the link is paid or cancelled.
          const waiting = new Set(s.orders.filter((o) => o.bookingId === b.id && payState(o, s.payments) === 'pending').map((o) => o.id))
          const parts = transferParts(d.folioOf(b), s.orders, input.instruction, waiting)
          if (partsTotal(parts) <= 0) throw new RuleError('CITY_LEDGER_NOTHING', `${b.code} has nothing ${BILLING_INSTRUCTION_LABEL[input.instruction].toLowerCase()} to transfer.`)
          const posted = post(b, a, input.instruction, parts)
          d.syncBooking(b.id)
          log('create', 'city-ledger', a.code, `Transferred ${rupiah(partsTotal(parts))} of ${b.code} to ${a.code} ${a.name}, ${BILLING_INSTRUCTION_LABEL[input.instruction].toLowerCase()}`, null, { amount: partsTotal(parts), bookingId: b.code })
          return copy(posted)
        }),
      ),
    transferGroup: (groupId, accountId) =>
      later(() =>
        atomically(() => {
          const group = findById(s.bookingGroups, groupId, 'group')
          if (group.billing !== 'master') throw new RuleError('GROUP_NOT_MASTER', `${group.code} bills each stay on its own; transfer each stay from its folio.`)
          const a = account(accountId)
          const stays = s.bookings.filter((b) => b.bookingGroupId === group.id && (b.status === 'checked_in' || b.status === 'checked_out'))
          const posted = stays.flatMap((b) => {
            const parts = transferParts(d.folioOf(b, true), s.orders, 'room')
            if (partsTotal(parts) <= 0) return []
            assertTransferable(b, a)
            const out = post(b, a, 'room', parts)
            d.syncBooking(b.id)
            return out
          })
          const total = posted.reduce((sum, p) => sum + p.amount, 0)
          if (total <= 0) throw new RuleError('CITY_LEDGER_NOTHING', `The master folio of ${group.code} has nothing to transfer.`)
          log('create', 'city-ledger', a.code, `Transferred the master folio of ${group.code} to ${a.code} ${a.name}: ${rupiah(total)}`, null, { amount: total, group: group.code })
          return copy(posted)
        }),
      ),
    invoices: () => later(() => copy(s.cityLedgerInvoices)),
    issueInvoice: (accountId, through) =>
      later(() =>
        atomically(() => {
          const a = account(accountId)
          if (through > today()) throw new RuleError('VALIDATION_ERROR', 'Invoice transfers up to today at the latest.')
          const open = openTransfers(a.id, s.folioPostings, s.cityLedgerInvoices).filter((p) => p.date <= through)
          if (open.length === 0) throw new RuleError('CITY_LEDGER_NOTHING', `${a.name} has no transfer up to ${through} left to invoice.`)
          const lines = [...new Set(open.map((p) => p.bookingId))].map((bookingId) => {
            const b = findById(s.bookings, bookingId, 'booking')
            const mine = open.filter((p) => p.bookingId === bookingId)
            return {
              postingIds: mine.map((p) => p.id),
              bookingId,
              code: b.code,
              guest: s.guests.find((g) => g.id === b.guestId)?.name ?? '',
              villa: s.catalog().place(b.unitId).villa.name,
              checkIn: b.checkIn,
              checkOut: b.checkOut,
              covers: mine[0]?.cityLedger?.instruction ?? 'all',
              gross: mine.reduce((sum, p) => sum + p.amount, 0),
              service: mine.reduce((sum, p) => sum + (p.cityLedger?.service ?? 0), 0),
              pb1: mine.reduce((sum, p) => sum + (p.cityLedger?.pb1 ?? 0), 0),
            }
          })
          const issuedOn = today()
          const figures = invoiceFigures(lines, a.commissionPct)
          const inv: CityLedgerInvoice = { id: `cli-${seq('clInvoice')}`, number: invoiceNumber(issuedOn, s.cityLedgerInvoices), accountId: a.id, issuedOn, dueOn: dueDate(issuedOn, a.termsDays), lines, ...figures, messageId: null, sentAt: null, journalId: null, issuedBy: user().name }
          inv.journalId = d.ledger.recordCommission(inv)
          s.cityLedgerInvoices.push(inv)
          log('create', 'city-ledger-invoice', inv.number, `Issued ${inv.number} to ${a.name}: ${rupiah(inv.net)}${inv.commission ? ` after ${rupiah(inv.commission)} commission` : ''}, due ${inv.dueOn}`, null, { gross: inv.gross, commission: inv.commission, net: inv.net })
          return copy(inv)
        }),
      ),
    sendInvoice: (invoiceId) =>
      later(() => {
        const inv = findById(s.cityLedgerInvoices, invoiceId, 'invoice')
        const a = account(inv.accountId)
        const t = s.messaging.templates.find((x) => x.key === 'city_ledger_invoice')
        const vars = { guest: a.contact, code: inv.number, amount: inv.net, due: inv.dueOn }
        const n = seq('message')
        const now = clockNow()
        const me = user()
        const m: Message = {
          id: `msg-${n}`,
          number: `MSG-${String(n).padStart(4, '0')}`,
          bookingId: '',
          guestId: '',
          to: a.billingEmail,
          channel: 'email',
          templateKey: 'city_ledger_invoice',
          language: 'en',
          subject: t ? renderTemplate(t.subject.en, vars) : `Invoice ${inv.number}`,
          body: t ? renderTemplate(t.body.en, vars) : '',
          status: a.billingEmail ? 'queued' : 'failed',
          sentBy: me.name,
          sentById: me.id,
          queuedAt: now,
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          failedAt: a.billingEmail ? null : now,
          error: a.billingEmail ? '' : 'No billing email on the account',
          attempts: 1,
          cityLedger: { accountId: a.id, invoiceId: inv.id },
        }
        s.messages.push(m)
        inv.messageId = m.id
        inv.sentAt = now
        log('update', 'city-ledger-invoice', inv.number, `Emailed ${inv.number} to ${a.billingEmail || a.name}`, null, { message: m.number })
        return copy(inv)
      }),
    payments: () => later(() => copy(s.cityLedgerPayments)),
    recordPayment: (input) =>
      later(() =>
        atomically(() => {
          refuse(validateCityLedgerPayment(input))
          const a = account(input.accountId)
          const box = findById(s.cashAccounts, input.cashAccountId, 'cash account')
          if ((input.method === 'cash') !== (box.kind === 'cashbox')) refuse({ cashAccountId: input.method === 'cash' ? 'Cash lands in a cashbox.' : 'A transfer lands in the bank.' })
          const open = allocatable(invoicesOf(a.id), settleSources())
          const allocations = input.allocations ?? oldestFirst(input.amount, open)
          for (const x of allocations) {
            const room = open.find((o) => o.invoiceId === x.invoiceId)
            if (!room) refuse({ allocations: 'Pick invoices of this account.' })
            else if (x.amount > room.open) refuse({ allocations: `${findById(s.cityLedgerInvoices, x.invoiceId, 'invoice').number} has only ${rupiah(room.open)} open.` })
          }
          const n = seq('clPayment')
          const number = `CLP-${String(n).padStart(4, '0')}`
          const t = d.newTransaction({ accountId: box.id, kind: 'cash_in', categoryId: 'cat-city-ledger', amount: input.amount, date: today(), locationId: box.locationId ?? s.locations[0]?.id ?? '', villaId: null, unitId: null, bookingId: null, description: `City ledger payment ${number} from ${a.name}`, reference: input.reference.trim(), attachments: [], transferId: null, origin: input.method === 'cash' ? 'front_desk' : 'payment' }, true)
          const p: CityLedgerPayment = { id: `clp-${n}`, number, accountId: a.id, date: today(), method: input.method, amount: input.amount, reference: input.reference.trim(), note: input.note.trim(), allocations: allocations.filter((x) => x.amount > 0), transactionId: t.id, createdBy: user().name }
          s.cityLedgerPayments.push(p)
          log('create', 'city-ledger-payment', p.number, `Recorded ${p.number} from ${a.name}: ${rupiah(p.amount)}${unapplied(p) > 0 ? `, ${rupiah(unapplied(p))} kept as credit` : ''}`, null, { amount: p.amount, transaction: t.number })
          return copy(p)
        }),
      ),
    applyCredit: (accountId) =>
      later(() => {
        const a = account(accountId)
        const rules = statusRules((id) => s.transactions.find((t) => t.id === id)?.status, (id) => s.manualJournals.find((m) => m.id === id)?.status)
        const changed = s.cityLedgerPayments
          .filter((p) => p.accountId === a.id && rules.paymentLive(p) && unapplied(p) > 0)
          .sort((x, y) => x.date.localeCompare(y.date))
          .flatMap((p) => {
            const add = oldestFirst(unapplied(p), allocatable(invoicesOf(a.id), settleSources()))
            if (add.length === 0) return []
            p.allocations = [...p.allocations, ...add]
            return [p]
          })
        if (changed.length === 0) throw new RuleError('CITY_LEDGER_NOTHING', `${a.name} has no credit to spread, or no invoice open.`)
        log('update', 'city-ledger-payment', a.code, `Spread the credit of ${a.name} over its open invoices: ${changed.map((p) => p.number).join(', ')}`)
        return copy(changed)
      }),
    writeOffs: () => later(() => copy(s.cityLedgerWriteOffs)),
    writeOff: (input) =>
      later(() =>
        atomically(() => {
          const a = account(input.accountId)
          const inv = findById(s.cityLedgerInvoices, input.invoiceId, 'invoice')
          if (inv.accountId !== a.id) throw new RuleError('VALIDATION_ERROR', `${inv.number} is not on ${a.name}.`)
          const open = allocatable([inv], settleSources())[0]?.open ?? 0
          refuse(validateWriteOff(input, open))
          assertWriteOffLimit(input.amount)
          const m = d.ledger.newManualJournal({ date: today(), villaId: null, memo: `Write-off on ${inv.number}, ${a.name}: ${input.reason.trim()}`, lines: [{ accountId: GL.badDebt, debit: input.amount, credit: 0 }, { accountId: GL.cityLedger, debit: 0, credit: input.amount }], attachments: [] }, true)
          const n = seq('clWriteOff')
          const w = { id: `clw-${n}`, number: `CLW-${String(n).padStart(4, '0')}`, accountId: a.id, invoiceId: inv.id, amount: input.amount, reason: input.reason.trim(), manualJournalId: m.id, createdBy: user().name, createdOn: today() }
          s.cityLedgerWriteOffs.push(w)
          log('create', 'city-ledger-write-off', w.number, `Asked to write off ${rupiah(w.amount)} on ${inv.number}: ${w.reason}`, null, { amount: w.amount, journal: m.number })
          return copy(w)
        }),
      ),
  }

  return { port, billing }
}
