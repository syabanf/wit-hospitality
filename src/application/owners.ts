import type { Action, Module, User } from '@/domain/access'
import { earns, SOURCE_LABEL } from '@/domain/booking'
import { findById, NotFoundError, RuleError } from '@/domain/errors'
import { awaitsApproval } from '@/domain/finance'
import {
  coversMonth,
  ownerNightsUsed,
  payoutDue,
  payoutState,
  PAYOUT_STATE_LABEL,
  portalSpan,
  previousStatement,
  settlement,
  statementDraft,
  statementLabel,
  validateContract,
  type ContractInput,
  type ManagementContract,
  type OwnerStatement,
  type OwnerStayInput,
  type PortalCalendarSpan,
  type VillaOwnerInput,
} from '@/domain/owner'
import { delta, monthsIn, onTheBooks, roomKpis, type InclusiveRange } from '@/domain/performance'
import type { Catalog } from '@/domain/property'
import { roomStats, segmentOf } from '@/domain/revenue'
import { addDays, addMonths, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { ReportFilter } from './reports'
import type { ReportRow } from './views'

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  /** `portal` lets a villa owner's portal read their villas. */
  catalog: (portal?: boolean) => Promise<Catalog>
  check: (errors: Record<string, string | undefined>) => void
}

export const OWNER_REPORTS = new Set(['owner-statements', 'owner-payouts'])

const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)

export interface PortalFilter extends InclusiveRange {
  compareFrom: IsoDate
  compareTo: IsoDate
}

/**
 * Villa owners for the operator (contracts, monthly statements, payouts and owner stays, under
 * Finance) and the owner portal, where an investor reads their own villas and nothing else.
 */
export function createOwnerServices({ ports, today, allow, catalog, check }: Deps) {
  async function books(portal = false) {
    const [cat, owners, contracts, statements, stays, transactions] = await Promise.all([catalog(portal), ports.owners.owners(), ports.owners.contracts(), ports.owners.statements(), ports.owners.stayRequests(), ports.finance.transactions()])
    const villaIds = new Set(cat.villas.map((v) => v.id))
    const mine = contracts.filter((c) => villaIds.has(c.villaId))
    const ownerName = (id: string) => owners.find((o) => o.id === id)?.name ?? id
    const payoutOf = (st: OwnerStatement) => (st.payoutTransactionId ? (transactions.find((t) => t.id === st.payoutTransactionId) ?? null) : null)
    const describe = (st: OwnerStatement) => {
      const payout = payoutOf(st)
      const state = payoutState(payout?.status ?? null)
      const contract = findById(contracts, st.contractId, 'contract')
      return { ...st, villaName: cat.villa(st.villaId).name, ownerName: ownerName(st.ownerId), payout, payoutState: state, payoutLabel: PAYOUT_STATE_LABEL[state], label: statementLabel(st, state), dueOn: payoutDue(st.month, contract.payoutDay) }
    }
    return {
      cat,
      owners,
      contracts: mine.map((c) => ({ ...c, villa: cat.villa(c.villaId), ownerName: ownerName(c.ownerId) })),
      statements: statements.filter((st) => villaIds.has(st.villaId)).map(describe),
      stays: stays.filter((r) => villaIds.has(r.villaId)).map((r) => ({ ...r, villaName: cat.villa(r.villaId).name, ownerName: ownerName(r.ownerId), unitCode: r.unitId ? cat.unit(r.unitId).code : '' })),
    }
  }

  /**
   * The month's figures for a contract from the books, by the villa P&L rules the owner reports print
   * (`pnl-villa`), with the stays and entries behind them and any shortfall brought forward.
   */
  async function draft(contract: ManagementContract, month: string) {
    const [bookings, blocks, categories, transactions, accounts, periods, statements, cat] = await Promise.all([ports.booking.bookings(), ports.booking.blocks(), ports.finance.categories(), ports.finance.transactions(), ports.airbnb.accounts(), ports.payroll.periods(), ports.owners.statements(), catalog()])
    const d = statementDraft(contract, month, { bookings, blocks, transactions, categories, accounts, periods, units: cat.units })
    const pending = transactions.filter((t) => t.villaId === contract.villaId && awaitsApproval(t) && t.date.slice(0, 7) === month).length
    return { ...d, settlement: settlement(d.figures.netPayable, previousStatement(statements, contract.id, month)), pending }
  }

  /** One statement as a page shows it: the closed record, or the figures so far when still open. */
  async function statementView(contractId: string, month: string, portal = false) {
    const w = await books(portal)
    const contract = w.contracts.find((c) => c.id === contractId)
    if (!contract) throw new NotFoundError('contract', contractId)
    const closed = w.statements.find((st) => st.contractId === contractId && st.month === month) ?? null
    const open = closed ? null : await draft(contract, month)
    const owner = findById(w.owners, contract.ownerId, 'villa owner')
    return {
      contract,
      owner,
      villa: contract.villa,
      location: w.cat.location(contract.villa.locationId),
      month,
      statement: closed,
      figures: closed?.figures ?? open?.figures ?? null,
      settlement: closed ? { broughtFrom: closed.broughtFrom, broughtForward: closed.broughtForward, payable: closed.payable } : (open?.settlement ?? null),
      stays: closed?.stays ?? open?.stays ?? [],
      entries: closed?.entries ?? open?.entries ?? [],
      pending: open?.pending ?? 0,
      dueOn: payoutDue(month, contract.payoutDay),
      today: today(),
    }
  }

  /** The investor's owner record, their contracts and villas. Operator staff have none. */
  async function portalWorld() {
    const user = await allow('portal', 'view')
    const w = await books(true)
    const owner = w.owners.find((o) => o.userId === user.id)
    if (!owner) throw new RuleError('FORBIDDEN', 'No villa owner is linked to this login.')
    const contracts = w.contracts.filter((c) => c.ownerId === owner.id)
    return { ...w, user, owner, contracts, villas: contracts.map((c) => c.villa) }
  }

  async function reportRows(slug: string, f: ReportFilter & { from: string; to: string }): Promise<ReportRow[]> {
    const w = await books()
    const inScope = (villaId: string) => (!f.villaId || villaId === f.villaId) && (!f.locationId || w.cat.villa(villaId).locationId === f.locationId)
    const months = (m: string) => m >= f.from.slice(0, 7) && m <= f.to.slice(0, 7)
    const list = w.statements.filter((st) => inScope(st.villaId) && months(st.month)).sort((a, b) => a.month.localeCompare(b.month) || a.villaName.localeCompare(b.villaName))
    if (slug === 'owner-statements')
      return list.map((st) => {
        const x = st.figures
        return { month: st.month, number: st.number, villa: st.villaName, owner: st.ownerName, roomRevenue: x.roomRevenue, otherRevenue: x.otherRevenue, charged: -x.charged, gop: x.gop, fee: -x.managementFee, reserve: -x.reserve, ownerStays: -x.ownerStayCharge, net: x.netPayable, brought: st.broughtForward ? -st.broughtForward : 0, payable: st.payable, status: st.label }
      })
    return list
      .filter((st) => st.status === 'approved')
      .map((st) => ({ number: st.number, villa: st.villaName, owner: st.ownerName, dueOn: st.dueOn, payout: st.payout?.number ?? '', paidOn: st.payoutState === 'paid' ? st.payout?.date ?? '' : '', amount: st.payable, status: st.label }))
  }

  return {
    reportRows,

    /** Owners, contracts and owner stay requests in the villas the user may see. */
    async overview() {
      await allow('finance', 'view')
      const w = await books()
      const year = today().slice(0, 4)
      return {
        owners: w.owners,
        contracts: w.contracts.map((c) => ({ ...c, nightsUsed: ownerNightsUsed(w.stays, c.id, year) })),
        stays: w.stays.sort((a, b) => b.requestedOn.localeCompare(a.requestedOn)),
        catalog: w.cat,
        today: today(),
      }
    },
    async saveOwner(id: string | null, input: VillaOwnerInput) {
      await allow('finance', 'post')
      return id ? ports.owners.updateOwner(id, input) : ports.owners.createOwner(input)
    },
    async saveContract(id: string | null, input: ContractInput) {
      await allow('finance', 'post')
      check(validateContract(input, await ports.owners.contracts(), id ?? undefined))
      return id ? ports.owners.updateContract(id, input) : ports.owners.createContract(input)
    },

    /** Every contract that runs in the month, with its statement or the figures so far. */
    async statements(month: string) {
      await allow('finance', 'view')
      const w = await books()
      const running = w.contracts.filter((c) => coversMonth(c, month))
      const rows = await Promise.all(
        running.map(async (c) => {
          const closed = w.statements.find((st) => st.contractId === c.id && st.month === month) ?? null
          if (closed) return { contract: c, statement: closed, figures: closed.figures, payable: closed.payable }
          const open = await draft(c, month)
          return { contract: c, statement: null, figures: open.figures, payable: open.settlement.payable }
        }),
      )
      const accounts = (await ports.finance.accounts()).filter((a) => a.kind === 'bank')
      return { month, rows, accounts, today: today() }
    },
    async statement(contractId: string, month: string) {
      await allow('finance', 'view')
      const [view, accounts] = await Promise.all([statementView(contractId, month), ports.finance.accounts()])
      return { ...view, banks: accounts.filter((a) => a.kind === 'bank') }
    },
    async close(contractId: string, month: string, note: string) {
      await allow('finance', 'post')
      const contract = findById(await ports.owners.contracts(), contractId, 'contract')
      const d = await draft(contract, month)
      return ports.owners.closeStatement({ contractId, month, base: d.base, stays: d.stays, entries: d.entries, note })
    },
    async approve(id: string, note: string) {
      await allow('finance', 'approve')
      return ports.owners.approveStatement(id, note)
    },
    async pay(id: string, accountId: string) {
      await allow('finance', 'post')
      return ports.owners.payStatement(id, accountId)
    },
    /** Takes an unpaid statement back to open and reverses its close journal, so corrections flow in. */
    async reopen(id: string, reason: string) {
      await allow('finance', 'post')
      return ports.owners.reopenStatement(id, reason)
    },
    async decideStay(id: string, decision: { approve: true; unitId: string; note: string } | { approve: false; note: string }) {
      await allow('booking', 'approve')
      return ports.owners.decideStay(id, decision)
    },

    portal: {
      /** Occupancy, ADR, RevPAR and room revenue of the owner's villas against the comparison range, from the stays. */
      async performance(f: PortalFilter) {
        const p = await portalWorld()
        const [bookings, blocks, groups] = await Promise.all([ports.booking.bookings(), ports.booking.blocks(), ports.groups.groups()])
        const sourceOf = (id?: string) => groups.find((g) => g.id === id)?.source ?? null
        const part = (villaId?: string) => {
          const units = p.cat.units.filter((u) => u.status !== 'inactive' && p.villas.some((v) => v.id === u.villaId) && (!villaId || u.villaId === villaId))
          const ids = new Set(units.map((u) => u.id))
          return { units: units.length, stays: bookings.filter((b) => ids.has(b.unitId)).map((b) => ({ ...b, segment: segmentOf(b, sourceOf(b.bookingGroupId)) })), blocks: blocks.filter((k) => ids.has(k.unitId)) }
        }
        const stats = (r: InclusiveRange, villaId?: string) => {
          const x = part(villaId)
          return roomStats(x.stays, x.units, x.blocks, r.from, addDays(r.to, 1))
        }
        const range = { from: f.from, to: f.to }
        const previous = { from: f.compareFrom, to: f.compareTo }
        const kpis = (villaId?: string) => {
          const now = stats(range, villaId)
          const before = stats(previous, villaId)
          return { occupancy: delta(now.occupancy, before.occupancy), adr: delta(now.adr, before.adr), revpar: delta(now.revpar, before.revpar), revenue: delta(now.revenue, before.revenue), sold: now.sold, available: now.available }
        }
        const trendFrom = addMonths(`${f.to.slice(0, 7)}-01`, -5)
        const paid = p.statements.filter((st) => st.status === 'approved')
        const all = part()
        return {
          owner: p.owner,
          range,
          compare: previous,
          today: today(),
          kpis: kpis(),
          villas: p.contracts.map((c) => ({ id: c.villaId, name: c.villa.name, contract: c.number, kpis: kpis(c.villaId) })),
          trend: monthsIn({ from: trendFrom, to: f.to }).map((m) => ({ month: m.month, ...roomKpis(stats(m).revenue, stats(m).sold, stats(m).available), revenue: stats(m).revenue })),
          books: [30, 60, 90].map((days) => onTheBooks(all.stays, all.units, today(), days)),
          netYear: sum(paid.filter((st) => st.month.startsWith(today().slice(0, 4))).map((st) => st.figures.netPayable)),
          latest: paid.sort((a, b) => b.month.localeCompare(a.month))[0] ?? null,
        }
      },

      /** Stays, owner stays and blocks on the owner's units; guests stay anonymous, only dates and source show. */
      async calendar(from: IsoDate, days: number) {
        const p = await portalWorld()
        const to = addDays(from, days)
        const [bookings, blocks, accounts] = await Promise.all([ports.booking.bookings(), ports.booking.blocks(), ports.airbnb.accounts()])
        const units = p.cat.units.filter((u) => p.villas.some((v) => v.id === u.villaId))
        const ids = new Set(units.map((u) => u.id))
        const code = (unitId: string) => p.cat.unit(unitId).code
        const spans: PortalCalendarSpan[] = [
          ...bookings
            .filter((b) => ids.has(b.unitId) && b.unitAssigned && earns(b) && b.checkIn < to && b.checkOut > from)
            .map((b) => portalSpan(b, code(b.unitId), b.airbnbAccountId ? `Airbnb, ${accounts.find((a) => a.id === b.airbnbAccountId)?.name ?? ''}`.replace(/, $/, '') : SOURCE_LABEL[b.source])),
          ...blocks.filter((k) => ids.has(k.unitId) && k.from < to && k.to > from).map((k): PortalCalendarSpan => ({ id: k.id, unitId: k.unitId, unitCode: code(k.unitId), from: k.from, to: k.to, kind: k.reason === 'owner' ? 'owner' : 'block', label: k.reason === 'owner' ? 'Owner stay' : 'Closed' })),
        ]
        return { from, to, days, villas: p.villas, units: units.map((u) => ({ id: u.id, code: u.code, villaId: u.villaId })), spans, today: today() }
      },

      /** Approved statements, newest first, with their payout. */
      async statements() {
        const p = await portalWorld()
        return p.statements.filter((st) => st.status === 'approved').sort((a, b) => b.month.localeCompare(a.month) || a.villaName.localeCompare(b.villaName))
      },
      async statement(id: string) {
        const p = await portalWorld()
        const st = p.statements.find((x) => x.id === id && x.status === 'approved')
        if (!st) throw new NotFoundError('owner statement', id)
        const view = await statementView(st.contractId, st.month, true)
        // Booking codes stay with the operator.
        return { ...view, stays: view.stays.map((x) => ({ ...x, code: '', bookingId: '' })), owner: p.owner }
      },

      /** Owner stay requests and each contract's allowance this year. */
      async stays() {
        const p = await portalWorld()
        const year = today().slice(0, 4)
        return {
          contracts: p.contracts.map((c) => ({ id: c.id, number: c.number, villa: c.villa, allowance: c.ownerNightsPerYear, used: ownerNightsUsed(p.stays, c.id, year), pricing: c.ownerStayPricing, price: c.ownerStayPrice, start: c.start, end: c.end })),
          requests: p.stays.sort((a, b) => b.checkIn.localeCompare(a.checkIn)),
          today: today(),
        }
      },
      async requestStay(input: OwnerStayInput) {
        await allow('portal', 'create')
        return ports.owners.requestStay(input)
      },

      /** The contracts and the owner's details on file. */
      async documents() {
        const p = await portalWorld()
        return { owner: p.owner, contracts: p.contracts }
      },
    },
  }
}

export type OwnerServices = ReturnType<typeof createOwnerServices>
