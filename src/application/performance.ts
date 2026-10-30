import {
  addPnl,
  delta,
  describeChanges,
  EMPTY_PNL,
  endOfMonth,
  monthsIn,
  onTheBooks,
  operatingMargin,
  roomKpis,
  totalRevenue,
  type InclusiveRange,
  type PnlLine,
} from '@/domain/performance'
import { unitsIn, type Scope } from '@/domain/property'
import { addMonths, startOfMonth, type IsoDate } from '@/lib/dates'
import { moneyCompact } from '@/lib/format'
import type { ReportFilter } from './reports'
import type { Services } from './services'
import type { ReportRow } from './views'

export interface OwnerFilter extends InclusiveRange {
  compareFrom: IsoDate
  compareTo: IsoDate
  locationId?: string
  villaId?: string
}

/** Expense categories that move money between accounts or restate payroll; they are not operating costs. */
const NOT_OPERATING = new Set(['Transfer out', 'Balance adjustment', 'Salaries and payroll'])
/** Income categories already counted as room revenue, or money held for the guest. */
const NOT_OTHER_INCOME = new Set(['Room revenue', 'Airbnb payout', 'Security deposit', 'Transfer in', 'Balance adjustment'])

const num = (v: ReportRow[string] | undefined) => Number(v ?? 0) || 0
const sumBy = (rows: readonly ReportRow[], key: string) => rows.reduce((s, r) => s + num(r[key]), 0)

/** A P&L report row back to positive lines: the reports print costs as negatives. */
const pnlOf = (r: ReportRow): PnlLine => ({ revenue: num(r.revenue), fees: -num(r.fees), other: num(r.other), expenses: -num(r.expenses), payroll: -num(r.payroll), profit: num(r.profit) })
const sumPnl = (rows: readonly ReportRow[]) => rows.map(pnlOf).reduce(addPnl, EMPTY_PNL)

/** Owner views built from the reports, so every figure matches the report it came from. */
export function createPerformance(services: Services) {
  const today = () => services.clock.today()
  const run = (slug: string, range: InclusiveRange, scope: Scope, extra: Partial<ReportFilter> = {}) => services.reports.run(slug, { from: range.from, to: range.to, locationId: scope.locationId, villaId: scope.villaId, ...extra }).then((r) => r.rows)
  const scoped = (scope: Scope) => Boolean(scope.locationId || scope.villaId)

  /**
   * The P&L for a range. The whole portfolio comes from `pnl-portfolio`, which also carries costs
   * mapped to a location but no villa; a scoped view sums the `pnl-villa` rows of its villas.
   */
  const pnl = async (range: InclusiveRange, scope: Scope) => sumPnl(await run(scoped(scope) ? 'pnl-villa' : 'pnl-portfolio', range, scope))

  async function monthly(range: InclusiveRange, scope: Scope) {
    const months = monthsIn(range)
    if (!scoped(scope)) {
      const rows = await run('pnl-portfolio', range, scope)
      return months.map((m, i) => ({ ...m, pnl: rows[i] ? pnlOf(rows[i]) : EMPTY_PNL }))
    }
    const lines = await Promise.all(months.map((m) => pnl(m, scope)))
    return months.map((m, i) => ({ ...m, pnl: lines[i] ?? EMPTY_PNL }))
  }

  async function rooms(range: InclusiveRange, scope: Scope) {
    const rows = await run('occupancy', range, scope)
    const revenue = sumBy(rows, 'revenue')
    return { rows, ...roomKpis(revenue, sumBy(rows, 'sold'), sumBy(rows, 'sellable')) }
  }

  async function costLines(range: InclusiveRange, scope: Scope, line: PnlLine) {
    const rows = await run('expense', range, scope)
    return [
      ...rows.filter((r) => !NOT_OPERATING.has(String(r.category))).map((r) => ({ id: String(r.category), label: String(r.category), value: num(r.amount) })),
      { id: 'airbnb-fees', label: 'Airbnb fees', value: line.fees },
      { id: 'payroll', label: 'Payroll allocation', value: line.payroll },
    ].filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
  }

  async function books(scope: Scope) {
    const [{ catalog }, { list }] = await Promise.all([services.dashboard.filterOptions(), services.booking.list()])
    const units = unitsIn(catalog, scope).filter((u) => u.status !== 'inactive').length
    const stays = list.filter((b) => (!scope.villaId || b.place.villa.id === scope.villaId) && (!scope.locationId || b.place.location.id === scope.locationId))
    return [30, 60, 90].map((days) => onTheBooks(stays, units, today(), days))
  }

  async function cash(scope: Scope, locationId?: string) {
    const fin = await services.dashboard.financial({ period: '30d', locationId: locationId ?? scope.locationId })
    return { total: fin.totalBalance, accounts: fin.accounts }
  }

  const trendRange = (to: IsoDate): InclusiveRange => ({ from: startOfMonth(addMonths(startOfMonth(to), -5)), to })

  return {
    async options() {
      const { catalog } = await services.dashboard.filterOptions()
      return { catalog, today: today() }
    },

    async overview(f: OwnerFilter) {
      const scope: Scope = { locationId: f.locationId, villaId: f.villaId }
      const range = { from: f.from, to: f.to }
      const previous = { from: f.compareFrom, to: f.compareTo }
      const [{ catalog }, current, before, villaNow, villaBefore, roomsNow, roomsBefore, sources, trend, onBooks] = await Promise.all([
        services.dashboard.filterOptions(),
        pnl(range, scope),
        pnl(previous, scope),
        run('pnl-villa', range, scope),
        run('pnl-villa', previous, scope),
        rooms(range, scope),
        rooms(previous, scope),
        run('revenue-source', range, scope),
        monthly(trendRange(f.to), scope),
        books(scope),
      ])
      const villaLocation = f.villaId ? catalog.villas.find((v) => v.id === f.villaId)?.locationId : undefined
      const [costs, balance] = await Promise.all([costLines(range, scope, current), cash(scope, villaLocation)])
      const idOf = (name: string) => catalog.villas.find((v) => v.name === name)?.id ?? name
      const villas = villaNow.map((r) => {
        const name = String(r.villa)
        const prev = villaBefore.find((p) => p.villa === name)
        const line = pnlOf(r)
        return { id: idOf(name), name, location: String(r.location), pnl: line, previous: prev ? pnlOf(prev) : EMPTY_PNL, margin: operatingMargin(line) }
      })
      return {
        range,
        compare: previous,
        today: today(),
        catalog,
        pnl: current,
        previousPnl: before,
        kpis: {
          profit: delta(current.profit, before.profit),
          revenue: delta(totalRevenue(current), totalRevenue(before)),
          room: delta(current.revenue, before.revenue),
          margin: delta(operatingMargin(current), operatingMargin(before)),
          occupancy: delta(roomsNow.occupancy, roomsBefore.occupancy),
          adr: delta(roomsNow.adr, roomsBefore.adr),
          revpar: delta(roomsNow.revpar, roomsBefore.revpar),
          cash: balance.total,
        },
        trend: trend.map((m) => ({ month: m.month, revenue: totalRevenue(m.pnl), costs: m.pnl.fees + m.pnl.expenses + m.pnl.payroll, profit: m.pnl.profit })),
        sources: sources.map((r) => ({ id: String(r.source), label: String(r.source), value: num(r.revenue) })).filter((s) => s.value > 0),
        villas: villas.sort((a, b) => b.pnl.profit - a.pnl.profit),
        costs,
        books: onBooks,
        changes: describeChanges({ current, previous: before }, villas.map((v) => ({ name: v.name, current: v.pnl, previous: v.previous })), moneyCompact),
      }
    },

    async villa(id: string, f: OwnerFilter) {
      const scope: Scope = { villaId: id }
      const range = { from: f.from, to: f.to }
      const previous = { from: f.compareFrom, to: f.compareTo }
      const { catalog } = await services.dashboard.filterOptions()
      const villa = catalog.villa(id)
      const [current, before, roomsNow, roomsBefore, trend, expenses, maintenance, payroll, onBooks, balance] = await Promise.all([
        pnl(range, scope),
        pnl(previous, scope),
        rooms(range, scope),
        rooms(previous, scope),
        monthly(trendRange(f.to), scope),
        run('expense', range, scope),
        run('maint-cost', range, scope),
        run('payroll-villa', { from: startOfMonth(range.from), to: range.to }, scope),
        books(scope),
        cash(scope, villa.locationId),
      ])
      return {
        villa,
        location: catalog.location(villa.locationId),
        range,
        compare: previous,
        today: today(),
        pnl: current,
        previousPnl: before,
        kpis: {
          profit: delta(current.profit, before.profit),
          revenue: delta(totalRevenue(current), totalRevenue(before)),
          room: delta(current.revenue, before.revenue),
          margin: delta(operatingMargin(current), operatingMargin(before)),
          occupancy: delta(roomsNow.occupancy, roomsBefore.occupancy),
          adr: delta(roomsNow.adr, roomsBefore.adr),
          revpar: delta(roomsNow.revpar, roomsBefore.revpar),
          cash: balance.total,
        },
        units: roomsNow.rows.map((r) => ({ unit: String(r.unit), revenue: num(r.revenue), occupancy: num(r.rate), adr: num(r.adr), sold: num(r.sold), blocked: num(r.blocked) })).sort((a, b) => b.revenue - a.revenue),
        months: trend.map((m) => ({ month: m.month, ...m.pnl })),
        expenses: expenses.filter((r) => !NOT_OPERATING.has(String(r.category))).map((r) => ({ category: String(r.category), amount: num(r.amount), entries: num(r.entries) })).sort((a, b) => b.amount - a.amount),
        maintenance: { total: sumBy(maintenance, 'total'), jobs: sumBy(maintenance, 'jobs'), open: sumBy(maintenance, 'open') },
        payroll: payroll.filter((r) => r.villa === villa.name).map((r) => ({ period: String(r.period), status: String(r.status), employees: num(r.employees), cost: num(r.cost) })),
        books: onBooks,
      }
    },

    /** A monthly owner statement for the portfolio or one villa, with last month beside it. */
    async statement(month: string, villaId?: string) {
      const scope: Scope = { villaId }
      const from = `${month}-01`
      const range = { from, to: endOfMonth(from) < today() ? endOfMonth(from) : today() }
      const lastFrom = addMonths(from, -1)
      const previous = { from: lastFrom, to: endOfMonth(lastFrom) }
      const { catalog } = await services.dashboard.filterOptions()
      const villa = villaId ? catalog.villa(villaId) : null
      const [current, before, sources, income, roomsNow, roomsBefore, maintenance, balance] = await Promise.all([
        pnl(range, scope),
        pnl(previous, scope),
        run('revenue-source', range, scope),
        run('income', range, scope),
        rooms(range, scope),
        rooms(previous, scope),
        run('maint-cost', range, scope),
        cash(scope, villa?.locationId),
      ])
      const [costs, costsBefore] = await Promise.all([costLines(range, scope, current), costLines(previous, scope, before)])
      const operating = (list: typeof costs) => list.filter((c) => c.id !== 'airbnb-fees' && c.id !== 'payroll')
      const labels = [...new Set([...operating(costs), ...operating(costsBefore)].map((c) => c.label))]
      return {
        month,
        range,
        previous,
        villa,
        location: villa ? catalog.location(villa.locationId) : null,
        catalog,
        today: today(),
        pnl: current,
        previousPnl: before,
        sources: sources.map((r) => ({ label: String(r.source), revenue: num(r.revenue), nights: num(r.nights) })).filter((s) => s.revenue > 0),
        otherIncome: income.filter((r) => !NOT_OTHER_INCOME.has(String(r.category))).map((r) => ({ label: String(r.category), amount: num(r.amount) })),
        costs: labels.map((label) => ({ label, amount: costs.find((c) => c.label === label)?.value ?? 0, before: costsBefore.find((c) => c.label === label)?.value ?? 0 })).sort((x, y) => y.amount - x.amount),
        maintenance: sumBy(maintenance, 'total'),
        rooms: { now: roomsNow, before: roomsBefore },
        cash: balance,
      }
    },
  }
}

export type Performance = ReturnType<typeof createPerformance>
export type AppServices = Services & { performance: Performance }
