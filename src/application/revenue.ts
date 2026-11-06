import type { Action, Module, User } from '@/domain/access'
import { change } from '@/domain/dashboard'
import { RuleError } from '@/domain/errors'
import { periodLabel } from '@/domain/payroll'
import { compareRange, endOfMonth, monthsIn, type CompareTo, type InclusiveRange } from '@/domain/performance'
import { unitsIn, type Catalog, type Scope } from '@/domain/property'
import {
  budgetRoomRevenue,
  covers,
  dailyStats,
  EMPTY_BUDGET_MONTH,
  historyStart,
  paceMonth,
  roomStats,
  SEGMENT_LABEL,
  SEGMENTS,
  segmentOf,
  variance,
  type BudgetInput,
  type BudgetMonth,
  validateBudget,
  type RoomStats,
  type Segment,
} from '@/domain/revenue'
import { addDays, addMonths, minIso, type IsoDate } from '@/lib/dates'
import type { Ports } from './ports'
import type { ReportFilter } from './reports'
import type { ReportResult, ReportRow } from './views'

export interface RevenueFilter extends InclusiveRange {
  compare: CompareTo
  locationId?: string
  villaId?: string
  segment?: Segment
}

/** A budget month's actual: room figures from the stays, other revenue and expenses from the P&L report. */
export interface ActualMonth {
  roomNights: number
  adr: number
  roomRevenue: number
  otherRevenue: number
  expenses: number
}

export interface BudgetRow {
  month: string
  budget: BudgetMonth
  /** Null for a month that has not started. */
  actual: ActualMonth | null
  /** The month is still running, so the actual is month to date. */
  partial: boolean
}

interface Deps {
  ports: Ports
  today: () => IsoDate
  allow: (module: Module, action: Action) => Promise<User>
  catalog: () => Promise<Catalog>
  report: (slug: string, f: ReportFilter) => Promise<ReportResult>
  /** Throws the field map the form shows beside its fields. */
  check: (errors: Record<string, string | undefined>) => void
}

export const PACE_MONTHS = 6
export const REVENUE_REPORTS = new Set(['rm-daily', 'rm-monthly', 'rm-pace', 'rm-budget'])

const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)
const num = (v: ReportRow[string] | undefined) => Number(v ?? 0) || 0
const monthsOfYear = (year: number) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)

/** Revenue management: statistics computed from stays and blocks, pace, forecast and budget against actual. */
export function createRevenueServices(d: Deps) {
  /** Active units in scope, their stays tagged by segment and their blocks. Stays on closed units stay out, like the occupancy report. */
  async function world(scope: Scope, segment?: Segment) {
    const [cat, bookings, blocks, groups] = await Promise.all([d.catalog(), d.ports.booking.bookings(), d.ports.booking.blocks(), d.ports.groups.groups()])
    const units = unitsIn(cat, scope).filter((u) => u.status !== 'inactive')
    const ids = new Set(units.map((u) => u.id))
    const sourceOf = (groupId?: string) => groups.find((g) => g.id === groupId)?.source ?? null
    const stays = bookings
      .filter((b) => ids.has(b.unitId))
      .map((b) => ({ ...b, segment: segmentOf(b, sourceOf(b.bookingGroupId)) }))
      .filter((b) => !segment || b.segment === segment)
    const held = blocks.filter((k) => ids.has(k.unitId))
    /** One villa's share of the scope. */
    const part = (villaId?: string) => {
      const mine = new Set(units.filter((u) => !villaId || u.villaId === villaId).map((u) => u.id))
      return { units: mine.size, stays: stays.filter((b) => mine.has(b.unitId)), blocks: held.filter((k) => mine.has(k.unitId)) }
    }
    /** Statistics over an inclusive range. */
    const stats = (r: InclusiveRange, villaId?: string) => {
      const p = part(villaId)
      return roomStats(p.stays, p.units, p.blocks, r.from, addDays(r.to, 1))
    }
    const inScope = unitsIn(cat, scope)
    return { cat, start: historyStart(bookings), villas: cat.villas.filter((v) => inScope.some((u) => u.villaId === v.id)), part, stats }
  }
  type World = Awaited<ReturnType<typeof world>>

  const pace = (w: World) => {
    const p = w.part()
    const first = `${d.today().slice(0, 7)}-01`
    return Array.from({ length: PACE_MONTHS }, (_, i) => paceMonth({ ...p, today: d.today(), start: w.start }, addMonths(first, i).slice(0, 7)))
  }

  /** Each month of the year for each villa in scope: room figures from the stays, other revenue and expenses from `pnl-villa`. */
  async function actuals(year: number, scope: Scope) {
    const w = await world(scope)
    const today = d.today()
    const started = monthsOfYear(year).filter((m) => `${m}-01` <= today)
    const pnl = await Promise.all(started.map((m) => d.report('pnl-villa', { from: `${m}-01`, to: minIso(endOfMonth(`${m}-01`), today), locationId: scope.locationId, villaId: scope.villaId }).then((r) => r.rows)))
    return {
      w,
      of(villaId: string, month: string): ActualMonth | null {
        const at = started.indexOf(month)
        if (at < 0) return null
        const rooms = w.stats({ from: `${month}-01`, to: minIso(endOfMonth(`${month}-01`), today) }, villaId)
        const row = pnl[at]?.find((r) => r.villa === w.cat.villa(villaId).name)
        return { roomNights: rooms.sold, adr: Math.round(rooms.adr), roomRevenue: rooms.revenue, otherRevenue: num(row?.other), expenses: -num(row?.expenses) }
      },
    }
  }

  async function budgetRows(year: number, scope: Scope) {
    const [{ w, of }, budgets] = await Promise.all([actuals(year, scope), d.ports.budget.budgets()])
    const thisMonth = d.today().slice(0, 7)
    return w.villas.map((villa) => {
      const budget = budgets.find((b) => b.villaId === villa.id && b.year === year) ?? null
      const rows: BudgetRow[] = monthsOfYear(year).map((month, i) => ({ month, budget: budget?.months[i] ?? EMPTY_BUDGET_MONTH, actual: of(villa.id, month), partial: month === thisMonth }))
      return { villa, budget, rows }
    })
  }

  return {
    async options() {
      await d.allow('reports', 'view')
      return { catalog: await d.catalog(), today: d.today() }
    },

    /** KPI tiles, core statistics with their comparison and last year, the 12-month trend, pace, source mix and villas. */
    async dashboard(f: RevenueFilter) {
      await d.allow('reports', 'view')
      const w = await world({ locationId: f.locationId, villaId: f.villaId }, f.segment)
      const range = { from: f.from, to: f.to }
      const before = compareRange(range, f.compare)
      const yearAgo = compareRange(range, 'last-year')
      const current = w.stats(range)
      const previous = covers(w.start, before.from) ? w.stats(before) : null
      const lastYear = covers(w.start, yearAgo.from) ? w.stats(yearAgo) : null
      const kpi = (key: 'occupancy' | 'adr' | 'revpar' | 'revenue') => ({ value: current[key], previous: previous?.[key] ?? null, change: previous ? change(current[key], previous[key]) : null })
      const today = d.today()
      const trend = monthsIn({ from: addMonths(`${today.slice(0, 7)}-01`, -11), to: today }).map((m) => {
        const s = w.stats(m)
        return { month: m.month, hasData: w.start !== null && w.start <= m.to, revenue: s.revenue, occupancy: s.occupancy, adr: s.adr, revpar: s.revpar, sold: s.sold }
      })
      const villas = w.villas.map((v) => {
        const s = w.stats(range, v.id)
        return { id: v.id, name: v.name, location: w.cat.location(v.locationId).name, available: s.available, sold: s.sold, occupancy: s.occupancy, adr: s.adr, revpar: s.revpar, revenue: s.revenue }
      })
      return {
        catalog: w.cat,
        today,
        range,
        compare: before,
        lastYearRange: yearAgo,
        kpis: { occupancy: kpi('occupancy'), adr: kpi('adr'), revpar: kpi('revpar'), revenue: kpi('revenue') },
        current,
        previous,
        lastYear,
        trend,
        pace: pace(w),
        mix: SEGMENTS.map((s) => ({ id: s, label: SEGMENT_LABEL[s], nights: current.mix[s].nights, value: current.mix[s].revenue })),
        villas: villas.sort((a, b) => b.revpar - a.revpar),
      }
    },

    /** One villa's budget for the year (or the scope summed) with the actual beside each month. */
    async budget(year: number, scope: Scope) {
      await d.allow('reports', 'view')
      const villas = await budgetRows(year, scope)
      const rows: BudgetRow[] = monthsOfYear(year).map((month, i) => {
        const at = villas.map((v) => v.rows[i]).filter((r): r is BudgetRow => Boolean(r))
        const actuals = at.map((r) => r.actual).filter((a): a is ActualMonth => a !== null)
        const nights = sum(at.map((r) => r.budget.roomNights))
        const revenue = sum(at.map((r) => budgetRoomRevenue(r.budget)))
        const roomNights = sum(actuals.map((a) => a.roomNights))
        const roomRevenue = sum(actuals.map((a) => a.roomRevenue))
        return {
          month,
          partial: at[0]?.partial ?? false,
          budget: { roomNights: nights, adr: nights ? Math.round(revenue / nights) : 0, otherRevenue: sum(at.map((r) => r.budget.otherRevenue)), expenses: sum(at.map((r) => r.budget.expenses)) },
          actual: at.some((r) => r.actual) ? { roomNights, roomRevenue, adr: roomNights ? Math.round(roomRevenue / roomNights) : 0, otherRevenue: sum(actuals.map((a) => a.otherRevenue)), expenses: sum(actuals.map((a) => a.expenses)) } : null,
        }
      })
      const one = scope.villaId ? villas[0] : undefined
      return { year, today: d.today(), rows, budget: one?.budget ?? null, villaCount: villas.length }
    },

    /** Last year's budget when there is one, else last year's actuals; null when the records hold neither. */
    async copyFromLastYear(villaId: string, year: number): Promise<BudgetMonth[] | null> {
      await d.allow('reports', 'view')
      const saved = (await d.ports.budget.budgets()).find((b) => b.villaId === villaId && b.year === year - 1)
      if (saved) return saved.months.map((m) => ({ ...m }))
      const { w, of } = await actuals(year - 1, { villaId })
      if (!w.start || w.start > `${year - 1}-12-31`) return null
      return monthsOfYear(year - 1).map((m) => {
        const a = of(villaId, m)
        return a ? { roomNights: a.roomNights, adr: a.adr, otherRevenue: a.otherRevenue, expenses: a.expenses } : { ...EMPTY_BUDGET_MONTH }
      })
    },

    async saveBudget(input: BudgetInput) {
      await d.allow('reports', 'report')
      await d.allow('finance', 'edit')
      const cat = await d.catalog()
      if (!cat.villas.some((v) => v.id === input.villaId)) throw new RuleError('FORBIDDEN', 'That villa is outside your scope.')
      d.check(validateBudget(input))
      return d.ports.budget.save(input)
    },

    /** Rows for the revenue management reports; the report runner has checked access. */
    async reportRows(slug: string, f: ReportFilter & InclusiveRange): Promise<ReportRow[]> {
      const scope: Scope = { locationId: f.locationId, villaId: f.villaId }
      if (slug === 'rm-budget') {
        const years = [...new Set(monthsIn(f).map((m) => Number(m.month.slice(0, 4))))]
        const all = (await Promise.all(years.map((y) => budgetRows(y, scope)))).flat()
        const wanted = new Set(monthsIn(f).map((m) => m.month))
        return all.flatMap(({ villa, rows }) =>
          rows
            .filter((r) => wanted.has(r.month))
            .map((r) => {
              const a = r.actual
              const room = variance(a?.roomRevenue ?? 0, budgetRoomRevenue(r.budget))
              const cost = variance(a?.expenses ?? 0, r.budget.expenses, true)
              return { villa: villa.name, month: periodLabel(r.month), budgetNights: r.budget.roomNights, actualNights: a?.roomNights ?? null, budgetRevenue: room.budget, actualRevenue: a ? room.actual : null, revenueVariance: a ? room.amount : null, revenuePct: a ? room.pct : null, budgetOther: r.budget.otherRevenue, actualOther: a?.otherRevenue ?? null, budgetExpenses: r.budget.expenses, actualExpenses: a ? cost.actual : null, expenseVariance: a ? cost.amount : null }
            }),
        )
      }
      const w = await world(scope)
      if (slug === 'rm-daily') {
        const p = w.part()
        return dailyStats(p.stays, p.units, p.blocks, f.from, addDays(f.to, 1)).map((s) => ({ date: s.date, available: s.available, blocked: s.blockedNights, sold: s.sold, occupancy: s.occupancy, adr: s.adr, revpar: s.revpar, revenue: s.revenue, arrivals: s.arrivals, cancellations: s.cancellations, noShows: s.noShows }))
      }
      if (slug === 'rm-monthly') {
        const row = (villa: string, month: string, s: RoomStats) => ({ villa, month, available: s.available, sold: s.sold, occupancy: s.occupancy, adr: s.adr, revpar: s.revpar, revenue: s.revenue, alos: Math.round(s.alos * 10) / 10, leadTime: Math.round(s.leadTime), cancellationRate: s.cancellationRate, noShowRate: s.noShowRate })
        return monthsIn(f).flatMap((m) => w.villas.map((v) => row(v.name, periodLabel(m.month), w.stats(m, v.id))))
      }
      if (slug === 'rm-pace') {
        return pace(w).map((p) => ({ month: periodLabel(p.month), available: p.available, nights: p.onBooks.nights, revenue: p.onBooks.revenue, occupancy: p.available ? p.onBooks.nights / p.available : 0, lastMonth: p.lastMonthSameLead.nights, pace: p.pace, forecastNights: p.forecast.nights, forecastRevenue: p.forecast.revenue, forecastOccupancy: p.forecastOccupancy }))
      }
      return []
    },
  }
}

export type RevenueServices = ReturnType<typeof createRevenueServices>
