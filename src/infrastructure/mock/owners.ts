import type { OwnerPort } from '@/application/ports'
import { ROLE_LABEL, type AuditAction, type User } from '@/domain/access'
import { canSignLevel } from '@/domain/approval'
import { findById, RuleError } from '@/domain/errors'
import { awaitsApproval, type Transaction } from '@/domain/finance'
import { assertOpenPeriod, numbered, ownerCloseJournal, ownerReopenJournal } from '@/domain/journal'
import {
  assertClosableStatement,
  assertDrillDown,
  assertReopenable,
  monthEnd,
  ownerNightsIn,
  payoutState,
  portalCalendarSpans,
  previousStatement,
  settlement,
  statementFigures,
  statementNumber,
  topsUp,
  validateContract,
  validateOwnerStay,
  type ContractInput,
  type ManagementContract,
  type OwnerStatement,
  type OwnerStayRequest,
  type VillaOwner,
  type VillaOwnerInput,
} from '@/domain/owner'
import { segmentOf } from '@/domain/revenue'
import { addDays } from '@/lib/dates'
import type { MockState } from './state'

type NewTransaction = Omit<Transaction, 'id' | 'number' | 'status' | 'approvals' | 'history' | 'rejectionReason' | 'reversalOf' | 'reversedBy' | 'createdBy' | 'createdById' | 'createdOn'>

export interface OwnerContext {
  s: MockState
  later: <T>(value: () => T) => Promise<T>
  copy: <T>(v: T) => T
  today: () => string
  seq: (key: string) => number
  user: () => User
  refuse: (errors: Record<string, string | undefined>) => void
  log: (action: AuditAction, entity: string, entityId: string, summary: string, before?: Record<string, unknown> | null, after?: Record<string, unknown> | null) => void
  newTransaction: (fields: NewTransaction, submit: boolean) => Transaction
  /** Refuses nights a stay or block already holds on the unit. */
  assertFree: (unitId: string, from: string, to: string) => void
}

/**
 * Villa owners and their contracts for the mock API. A villa owner signed in is served only their
 * own records; everything else stays the operator's.
 */
export function createOwnerAdapter({ s, later, copy, today, seq, user, refuse, log, newTransaction, assertFree }: OwnerContext): OwnerPort {
  /** The owner record behind an investor login, or null for operator staff. */
  const ownerOf = (u: User) => (u.role === 'investor' ? (s.villaOwners.find((o) => o.userId === u.id) ?? null) : undefined)
  /** Operator staff see every owner record; a villa owner theirs only. */
  function mine<T extends { ownerId: string }>(list: readonly T[]): T[] {
    const owner = ownerOf(user())
    return owner === undefined ? [...list] : list.filter((x) => x.ownerId === owner?.id)
  }
  function assertOperator(action: string) {
    if (user().role === 'investor') throw new RuleError('FORBIDDEN', `A villa owner cannot ${action}.`)
  }
  const villa = (id: string) => s.catalog().villa(id)

  function saveOwner(input: VillaOwnerInput) {
    refuse({ name: input.name.trim().length < 2 ? 'Enter the owner’s name.' : undefined, email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) ? undefined : 'Enter a valid email address.', bank: input.bank.accountNumber.trim() ? undefined : 'Enter the payout bank account.' })
    return { ...input, name: input.name.trim(), email: input.email.trim(), npwp: input.npwp.trim() }
  }

  function saveContract(input: ContractInput, id?: string) {
    refuse(validateContract(input, s.contracts, id))
    villa(input.villaId)
    findById(s.villaOwners, input.ownerId, 'villa owner')
  }

  return {
    owners: () =>
      later(() => {
        const owner = ownerOf(user())
        return copy(owner === undefined ? s.villaOwners : owner ? [owner] : [])
      }),
    createOwner: (input) =>
      later(() => {
        assertOperator('add owners')
        const owner: VillaOwner = { ...saveOwner(input), id: `own-${seq('villaOwner')}` }
        s.villaOwners.push(owner)
        log('create', 'villa-owner', owner.id, `Added villa owner ${owner.name}`)
        return copy(owner)
      }),
    updateOwner: (id, input) =>
      later(() => {
        assertOperator('edit owners')
        const owner = findById(s.villaOwners, id, 'villa owner')
        const before = { bank: owner.bank.accountNumber, email: owner.email }
        Object.assign(owner, saveOwner(input))
        log('update', 'villa-owner', id, `Edited villa owner ${owner.name}`, before, { bank: owner.bank.accountNumber, email: owner.email })
        return copy(owner)
      }),
    contracts: () => later(() => copy(mine(s.contracts))),
    createContract: (input) =>
      later(() => {
        assertOperator('add contracts')
        saveContract(input)
        const n = seq('contract')
        const contract: ManagementContract = { ...input, id: `ct-${n}`, number: `MC-${today().slice(0, 4)}-${String(n).padStart(2, '0')}`, createdOn: today() }
        s.contracts.push(contract)
        log('create', 'contract', contract.number, `Added contract ${contract.number} for ${villa(input.villaId).name}`, null, { feeBasis: input.feeBasis, feePct: input.feePct })
        return copy(contract)
      }),
    updateContract: (id, input) =>
      later(() => {
        assertOperator('edit contracts')
        const contract = findById(s.contracts, id, 'contract')
        saveContract(input, id)
        const before = { feeBasis: contract.feeBasis, feePct: contract.feePct, charged: contract.charged, reservePct: contract.reservePct }
        Object.assign(contract, input)
        log('update', 'contract', contract.number, `Edited contract ${contract.number}; closed statements keep their figures`, before, { feeBasis: contract.feeBasis, feePct: contract.feePct, charged: contract.charged, reservePct: contract.reservePct })
        return copy(contract)
      }),

    statements: () =>
      later(() => {
        const owner = ownerOf(user())
        // A villa owner sees a statement once the operator's owner approved it.
        return copy(mine(s.ownerStatements).filter((st) => owner === undefined || st.status === 'approved'))
      }),
    closeStatement: (input) =>
      later(() => {
        assertOperator('close statements')
        const me = user()
        const contract = findById(s.contracts, input.contractId, 'contract')
        const pending = s.transactions.filter((t) => t.villaId === contract.villaId && awaitsApproval(t) && t.date.slice(0, 7) === input.month).length
        assertClosableStatement(contract, input.month, today(), s.ownerStatements, pending)
        assertDrillDown(input.base, input.stays, input.entries)
        const end = addDays(monthEnd(input.month), 1)
        assertOpenPeriod(s.periodCloses, monthEnd(input.month))
        // Owner nights come from the blocks here, whatever the caller counted.
        const units = new Set(s.units.filter((u) => u.villaId === contract.villaId).map((u) => u.id))
        const owned = ownerNightsIn(s.blocks, units, `${input.month}-01`, end)
        const figures = statementFigures(contract, { ...input.base, ownerNights: owned.nights, ownerStays: owned.stays })
        const settled = settlement(figures.netPayable, previousStatement(s.ownerStatements, contract.id, input.month))
        const v = villa(contract.villaId)
        const st: OwnerStatement = {
          id: `os-${seq('statement')}`,
          number: statementNumber(input.month, v.code),
          contractId: contract.id,
          ownerId: contract.ownerId,
          villaId: contract.villaId,
          month: input.month,
          figures,
          stays: input.stays.map((x) => ({ ...x })),
          entries: input.entries.map((x) => ({ ...x })),
          status: 'closed',
          ...settled,
          shortfall: contract.shortfall,
          closedBy: me.name,
          closedById: me.id,
          closedOn: today(),
          approvedBy: null,
          approvedOn: null,
          note: input.note.trim(),
          payoutTransactionId: null,
          journalId: null,
        }
        const entry = numbered(ownerCloseJournal(st), seq('journal'), today(), me.name)
        s.journals.push(entry)
        st.journalId = entry.id
        s.ownerStatements.push(st)
        log('status', 'owner-statement', st.number, `Closed ${st.number}: net payable ${figures.netPayable}, ${settled.payable} after carry forward, management fee ${figures.managementFee}`, null, { netPayable: figures.netPayable, broughtForward: settled.broughtForward, payable: settled.payable, managementFee: figures.managementFee, reserve: figures.reserve })
        return copy(st)
      }),
    approveStatement: (id, note) =>
      later(() => {
        const me = user()
        const st = findById(s.ownerStatements, id, 'owner statement')
        if (st.status !== 'closed') throw new RuleError('STATEMENT_INVALID_STATE', `${st.number} is already approved.`)
        if (!canSignLevel(me.role, 'owner')) throw new RuleError('APPROVAL_ROLE', `An owner statement needs the Owner’s approval; you are ${ROLE_LABEL[me.role]}.`)
        if (st.closedById === me.id) throw new RuleError('APPROVAL_SELF', 'The person who closed a statement cannot approve it.')
        st.status = 'approved'
        st.approvedBy = me.name
        st.approvedOn = today()
        if (note.trim()) st.note = [st.note, note.trim()].filter(Boolean).join(' · ')
        log('approve', 'owner-statement', st.number, `Approved ${st.number}`, { status: 'closed' }, { status: 'approved' })
        return copy(st)
      }),
    payStatement: (id, accountId) =>
      later(() => {
        assertOperator('pay statements')
        const st = findById(s.ownerStatements, id, 'owner statement')
        if (st.status !== 'approved') throw new RuleError('STATEMENT_NOT_APPROVED', `${st.number} needs the Owner’s approval before it is paid.`)
        const topUp = topsUp(st)
        if (st.payable < 0 && !topUp) throw new RuleError('PAYOUT_NOTHING', `${st.number} carries ${-st.payable} forward to the next statement; nothing is paid this month.`)
        if (st.payable === 0) throw new RuleError('PAYOUT_NOTHING', `${st.number} leaves nothing to pay the owner.`)
        const previous = st.payoutTransactionId ? s.transactions.find((t) => t.id === st.payoutTransactionId) : undefined
        const state = payoutState(previous?.status ?? null)
        if (state === 'waiting' || state === 'paid') throw new RuleError('PAYOUT_OPEN', `${st.number} already has payout ${previous?.number}, ${previous?.status}.`)
        const account = findById(s.cashAccounts, accountId, 'cash account')
        if (account.kind !== 'bank') throw new RuleError('VALIDATION_ERROR', 'Owners are paid from a bank account.')
        const owner = findById(s.villaOwners, st.ownerId, 'villa owner')
        const v = villa(st.villaId)
        const where = { accountId, date: today(), locationId: v.locationId, villaId: v.id, unitId: null, bookingId: null, reference: st.number, attachments: [], origin: 'owner_payout' as const, transferId: null }
        const t = topUp
          ? newTransaction({ ...where, kind: 'cash_in', categoryId: 'cat-owner-topup', amount: -st.payable, description: `Owner top-up ${st.number} from ${owner.name}` }, true)
          : newTransaction({ ...where, kind: 'cash_out', categoryId: 'cat-owner-payout', amount: st.payable, description: `Owner payout ${st.number} to ${owner.name}, ${owner.bank.bank} ${owner.bank.accountNumber}` }, true)
        st.payoutTransactionId = t.id
        log('status', 'owner-statement', st.number, `Submitted ${topUp ? 'top-up' : 'payout'} ${t.number} for ${st.number}`, { payout: previous?.number ?? null }, { payout: t.number })
        return copy(st)
      }),
    reopenStatement: (id, reason) =>
      later(() => {
        assertOperator('reopen statements')
        const me = user()
        const st = findById(s.ownerStatements, id, 'owner statement')
        const payout = st.payoutTransactionId ? (s.transactions.find((t) => t.id === st.payoutTransactionId) ?? null) : null
        assertReopenable(st, s.ownerStatements, payout, reason)
        assertOpenPeriod(s.periodCloses, monthEnd(st.month))
        s.journals.push(numbered(ownerReopenJournal(st, reason.trim()), seq('journal'), today(), me.name))
        s.ownerStatements.splice(s.ownerStatements.indexOf(st), 1)
        log('status', 'owner-statement', st.number, `Reopened ${st.number}: ${reason.trim()}`, { status: st.status }, { status: 'open' })
        return copy(st)
      }),

    stayRequests: () => later(() => copy(mine(s.ownerStays))),
    requestStay: (input) =>
      later(() => {
        const me = user()
        const contract = findById(s.contracts, input.contractId, 'contract')
        const owner = ownerOf(me)
        if (owner !== undefined && owner?.id !== contract.ownerId) throw new RuleError('FORBIDDEN', 'You can ask for stays in your own villas only.')
        validateOwnerStay(input, contract, s.ownerStays, today())
        const n = seq('ownerStay')
        const r: OwnerStayRequest = { ...input, note: input.note.trim(), id: `osr-${n}`, number: `OSR-${String(n).padStart(3, '0')}`, ownerId: contract.ownerId, villaId: contract.villaId, status: 'pending', requestedOn: today(), unitId: null, blockId: null, decidedBy: null, decidedOn: null, decisionNote: '' }
        s.ownerStays.push(r)
        log('create', 'owner-stay', r.number, `Asked for an owner stay at ${villa(r.villaId).name}, ${r.checkIn} to ${r.checkOut}`)
        return copy(r)
      }),
    decideStay: (id, decision) =>
      later(() => {
        assertOperator('decide owner stays')
        const me = user()
        const r = findById(s.ownerStays, id, 'owner stay')
        if (r.status !== 'pending') throw new RuleError('OWNER_STAY_DECIDED', `${r.number} is already ${r.status}.`)
        if (decision.approve) {
          const unit = s.catalog().unit(decision.unitId)
          if (unit.villaId !== r.villaId) throw new RuleError('VALIDATION_ERROR', `${unit.code} is not in ${villa(r.villaId).name}.`)
          assertFree(unit.id, r.checkIn, r.checkOut)
          const owner = findById(s.villaOwners, r.ownerId, 'villa owner')
          const block = { id: `blk-${seq('block')}`, unitId: unit.id, from: r.checkIn, to: r.checkOut, reason: 'owner' as const, note: `Owner stay ${r.number}, ${owner.name}` }
          s.blocks.push(block)
          Object.assign(r, { status: 'approved', unitId: unit.id, blockId: block.id })
        } else {
          if (decision.note.trim().length < 3) throw new RuleError('VALIDATION_ERROR', 'Say why the stay is declined.')
          r.status = 'declined'
        }
        Object.assign(r, { decidedBy: me.name, decidedOn: today(), decisionNote: decision.note.trim() })
        log(decision.approve ? 'approve' : 'reject', 'owner-stay', r.number, `${decision.approve ? 'Approved' : 'Declined'} owner stay ${r.number}`, { status: 'pending' }, { status: r.status })
        return copy(r)
      }),

    portalCalendar: (from, days) =>
      later(() => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isInteger(days) || days < 1 || days > 366) throw new RuleError('VALIDATION_ERROR', 'Pick a start date and from 1 to 366 days.')
        const { villas, units } = portalUnits()
        const to = addDays(from, days)
        const spans = portalCalendarSpans(units, s.bookings, s.blocks, (id) => s.accounts.find((a) => a.id === id)?.name, from, to)
        return copy({ from, to, days, villas: villas.map(({ id, locationId, code, name }) => ({ id, locationId, code, name })), units: units.map(({ id, code, villaId }) => ({ id, code, villaId })), spans, today: today() })
      }),
    portalStays: () =>
      later(() => {
        const ids = new Set(portalUnits().units.map((u) => u.id))
        const groupSource = (id?: string) => s.bookingGroups.find((g) => g.id === id)?.source ?? null
        return copy({
          stays: s.bookings
            .filter((b) => ids.has(b.unitId))
            .map((b) => ({ unitId: b.unitId, status: b.status, checkIn: b.checkIn, checkOut: b.checkOut, createdOn: b.createdOn, listRates: b.listRates, rateOverride: b.rateOverride, discount: b.discount, segment: segmentOf(b, groupSource(b.bookingGroupId)) })),
          blocks: s.blocks.filter((k) => ids.has(k.unitId)).map((k) => ({ unitId: k.unitId, from: k.from, to: k.to })),
        })
      }),
  }

  /** The villas under the reader's contracts and their units; a login with neither a contract nor an owner record is refused. */
  function portalUnits() {
    const contracts = mine(s.contracts)
    if (!contracts.length && !ownerOf(user())) throw new RuleError('FORBIDDEN', 'No villa owner is linked to this login.')
    const cat = s.catalog()
    const villas = contracts.map((c) => cat.villa(c.villaId))
    return { villas, units: cat.units.filter((u) => villas.some((v) => v.id === u.villaId)) }
  }
}
