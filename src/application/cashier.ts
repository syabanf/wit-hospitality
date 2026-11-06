import type { Action, Module, User } from '@/domain/access'
import { canSignOffShift, handOverAmount, isShiftManager, shiftTotals, validateCount, validateShiftPolicy, SHIFT_STATUS_LABEL, type CashierShift, type CloseShiftInput, type DropInput, type OpenShiftInput, type ShiftPolicy, type ShiftTotals } from '@/domain/cashier'
import { findById, RuleError } from '@/domain/errors'
import type { Catalog, Scope } from '@/domain/property'
import type { IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { ReportRow } from './views'

export interface ShiftView extends CashierShift {
  accountName: string
  locationName: string
  /** The drawer from the stamped entries: live while open, the breakdown behind the count once closed. */
  totals: ShiftTotals
}

interface Deps {
  ports: Ports
  today: () => IsoDate
  catalog: () => Promise<Catalog>
  allow: (module: Module, action: Action) => Promise<User>
  access: () => Promise<{ user: User; can: (module: Module, action: Action) => boolean }>
  check: (errors: Record<string, string | undefined>) => void
}

const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)

/**
 * Front desk cashier shifts. The desk opens and closes its own shift with the payments create
 * permission, the one it takes guest money with; the Shifts page reads with finance view, and a
 * difference past the tolerance is signed by a manager or someone who approves finance.
 */
export function createCashierServices({ ports, today, catalog, allow, access, check }: Deps) {
  async function world() {
    const [cat, shifts, handOvers, accounts, transactions, payments, categories, policy] = await Promise.all([catalog(), ports.cashier.shifts(), ports.cashier.handOvers(), ports.finance.accounts(), ports.finance.transactions(), ports.payment.payments(), ports.finance.categories(), ports.cashier.policy()])
    const locationIds = new Set(cat.locations.map((l) => l.id))
    const mine = shifts.filter((s) => locationIds.has(s.locationId))
    const describe = (s: CashierShift): ShiftView => ({
      ...s,
      accountName: findById(accounts, s.accountId, 'account').name,
      locationName: cat.location(s.locationId).name,
      totals: shiftTotals(s, transactions, payments),
    })
    const cashboxes = accounts.filter((a) => a.kind === 'cashbox' && a.locationId !== null && locationIds.has(a.locationId))
    return { cat, shifts: mine, views: mine.map(describe), describe, handOvers, accounts, cashboxes, transactions, payments, categories, policy }
  }

  async function signer() {
    const a = await access()
    return { ...a, signs: canSignOffShift(a.user.role, a.can('finance', 'approve')) }
  }

  /** The last counted shift on a cashbox whose drawer is still there to hand over. */
  const handOverFrom = (views: readonly ShiftView[], accountId: string) => [...views].reverse().find((s) => s.accountId === accountId && s.counted !== null && !s.handedOverId && handOverAmount(s) > 0) ?? null

  return {
    /** Every shift the user's locations hold, newest first, for the Shifts page. */
    async list() {
      await allow('finance', 'view')
      const [w, a] = await Promise.all([world(), signer()])
      return {
        shifts: [...w.views].reverse(),
        cashboxes: w.cashboxes,
        cashiers: [...new Set(w.views.map((s) => s.cashierName))].sort(),
        policy: w.policy,
        canSignOff: a.signs,
        canEditPolicy: a.can('finance', 'edit'),
        today: today(),
      }
    },

    /** The desk's view: each cashbox with its open shift or the drawer waiting to be handed over, and the user's own shift. */
    async desk() {
      const me = await allow('payments', 'create')
      const [w, assignments] = await Promise.all([world(), ports.hr.assignments()])
      const date = today()
      return {
        cashboxes: w.cashboxes.map((account) => {
          const open = w.views.find((s) => s.accountId === account.id && s.status === 'open') ?? null
          return { account, location: w.cat.location(account.locationId ?? ''), open, handOver: open ? null : handOverFrom(w.views, account.id) }
        }),
        mine: w.views.find((s) => s.cashierId === me.id && s.status === 'open') ?? null,
        rostered: Boolean(me.employeeId && assignments.some((x) => x.employeeId === me.employeeId && x.date === date && x.shiftId)),
        manager: isShiftManager(me.role),
        policy: w.policy,
      }
    },

    /** One shift with what it took, per method and category, its count, the hand-overs and the drop; the printable report reads it too. */
    async shift(id: string) {
      const [w, a] = await Promise.all([world(), signer()])
      // The Shifts page reads with finance view; the cashier at the desk reads their own drawer.
      if (!a.can('finance', 'view') && !a.can('payments', 'create')) throw new RuleError('FORBIDDEN', 'Your role cannot see cashier shifts.')
      const shift = w.describe(findById(w.shifts, id, 'cashier shift'))
      const categoryName = (categoryId: string) => w.categories.find((c) => c.id === categoryId)?.name ?? categoryId
      const entries = w.transactions.filter((t) => t.shiftId === id).sort((x, y) => x.number.localeCompare(y.number, undefined, { numeric: true }))
      const paymentRows = w.payments.filter((p) => p.shiftId === id)
      const bookings = paymentRows.length ? await ports.booking.bookings() : []
      const handOverIn = w.handOvers.find((h) => h.id === shift.handOverId) ?? null
      const handOverOut = w.handOvers.find((h) => h.id === shift.handedOverId) ?? null
      const drop = shift.dropTransactionId ? (w.transactions.find((t) => t.id === shift.dropTransactionId) ?? null) : null
      const dropIn = drop ? w.transactions.find((t) => t.transferId === drop.transferId && t.id !== drop.id) : undefined
      return {
        shift,
        entries: entries.map((t) => ({ ...t, categoryName: categoryName(t.categoryId) })),
        payments: paymentRows.map((p) => ({ ...p, bookingCode: bookings.find((b) => b.id === p.bookingId)?.code ?? '' })),
        categories: shift.totals.byCategory.map((c) => ({ ...c, name: categoryName(c.categoryId) })),
        handOverIn: handOverIn && { ...handOverIn, shift: w.shifts.find((x) => x.id === handOverIn.fromShiftId) ?? null },
        handOverOut: handOverOut && { ...handOverOut, shift: w.shifts.find((x) => x.id === handOverOut.toShiftId) ?? null },
        drop: drop && { transaction: drop, to: w.accounts.find((x) => x.id === dropIn?.accountId)?.name ?? '' },
        policy: w.policy,
        canSignOff: a.signs && shift.status === 'awaiting_signoff' && shift.cashierId !== a.user.id,
        canWork: shift.cashierId === a.user.id || a.signs,
        dropTargets: w.accounts.filter((x) => x.id !== shift.accountId && (x.kind === 'bank' || x.kind === 'cashbox')),
      }
    },

    async open(input: OpenShiftInput) {
      await allow('payments', 'create')
      if (!input.handOverFrom) check({ count: validateCount(input.count) ?? undefined })
      return ports.cashier.open(input)
    },
    async close(id: string, input: CloseShiftInput) {
      await allow('payments', 'create')
      check({ count: validateCount(input.count) ?? undefined })
      return ports.cashier.close(id, input)
    },
    async signOff(id: string, note: string) {
      const a = await signer()
      if (!a.signs) throw new RuleError('FORBIDDEN', 'A manager or someone who approves finance signs off a drawer difference.')
      return ports.cashier.signOff(id, note)
    },
    async drop(id: string, input: DropInput) {
      await allow('payments', 'create')
      return ports.cashier.drop(id, input)
    },
    async savePolicy(policy: ShiftPolicy) {
      await allow('finance', 'edit')
      check(validateShiftPolicy(policy))
      return ports.cashier.savePolicy(policy)
    },

    /** Shift summary and over and short by cashier, for the report registry. */
    async reportRows(slug: string, from: IsoDate, to: IsoDate, scope: Scope): Promise<ReportRow[]> {
      const w = await world()
      const inRange = w.views.filter((s) => s.businessDate >= from && s.businessDate <= to && (!scope.locationId || s.locationId === scope.locationId))
      if (slug === 'cashier-shifts')
        return inRange.map((s) => ({
          date: s.businessDate,
          shift: s.number,
          cashbox: s.accountName,
          cashier: s.cashierName,
          status: SHIFT_STATUS_LABEL[s.status],
          float: s.float,
          cashIn: s.totals.cashIn,
          cashOut: -s.totals.cashOut,
          expected: s.expected ?? s.totals.expected,
          counted: s.counted,
          difference: s.difference,
          nonCash: sum(s.totals.byMethod.filter((m) => m.method !== 'cash').map((m) => m.amount)),
        }))
      if (slug === 'cashier-over-short') {
        const closed = inRange.filter((s) => s.difference !== null)
        return [...new Set(closed.map((s) => s.cashierName))].sort().map((cashier) => {
          const mine = closed.filter((s) => s.cashierName === cashier)
          const diffs = mine.map((s) => s.difference ?? 0)
          return {
            cashier,
            shifts: mine.length,
            matched: diffs.filter((d) => d === 0).length,
            over: sum(diffs.filter((d) => d > 0)),
            short: sum(diffs.filter((d) => d < 0)),
            net: sum(diffs),
            beyond: mine.filter((s) => Math.abs(s.difference ?? 0) > w.policy.tolerance).length,
            signedOff: mine.filter((s) => s.signOff).length,
          }
        })
      }
      return []
    },
  }
}

export type CashierServices = ReturnType<typeof createCashierServices>
