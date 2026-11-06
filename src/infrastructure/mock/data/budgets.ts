import type { UnitBlock, Booking } from '@/domain/booking'
import { counts, type Transaction } from '@/domain/finance'
import type { Unit, Villa } from '@/domain/property'
import { historyStart, roomStats, segmentOf, type Budget, type BudgetMonth } from '@/domain/revenue'
import { addMonths, daysBetween, maxIso, type IsoDate } from '@/lib/dates'
import { round } from '../helpers'

/** Month by month the budget sits a little over or under the run rate, so the variance shows both colours. */
const WOBBLE = [1.06, 0.95, 1.03, 0.92, 1.08, 0.97, 1.04, 0.94]
const NOT_OTHER = new Set(['cat-room', 'cat-airbnb', 'cat-deposit'])
const SYSTEM = new Set(['transfer', 'adjustment', 'reconciliation'])

interface Seed {
  today: IsoDate
  villas: readonly Villa[]
  units: readonly Unit[]
  bookings: readonly Booking[]
  blocks: readonly UnitBlock[]
  transactions: readonly Transaction[]
}

/**
 * This year's budget for every villa, from the run rate of the last two complete months the
 * seed reaches: room nights and revenue per day from the stays, other income and expenses per day
 * from the posted entries, scaled to each month and nudged up or down.
 */
export function seedBudgets(s: Seed, by: string): Budget[] {
  const thisMonth = `${s.today.slice(0, 7)}-01`
  const posted = s.transactions.filter((t) => counts(t) && !t.reversalOf && !t.reversedBy && !SYSTEM.has(t.origin) && t.date < thisMonth)
  const txFrom = maxIso(posted.reduce((first, t) => (t.date < first ? t.date : first), thisMonth), addMonths(thisMonth, -2))
  const perDay = (total: number, from: IsoDate) => total / Math.max(1, daysBetween(from, thisMonth))
  const year = Number(s.today.slice(0, 4))

  return s.villas.map((villa, v) => {
    const units = s.units.filter((u) => u.villaId === villa.id && u.status !== 'inactive')
    const ids = new Set(units.map((u) => u.id))
    const stays = s.bookings.filter((b) => ids.has(b.unitId)).map((b) => ({ ...b, segment: segmentOf(b) }))
    const stayFrom = maxIso(historyStart(stays) ?? thisMonth, addMonths(thisMonth, -2))
    const rooms = roomStats(stays, units.length, s.blocks.filter((k) => ids.has(k.unitId)), stayFrom, thisMonth)
    const mine = posted.filter((t) => t.villaId === villa.id && t.date >= txFrom)
    const other = perDay(mine.filter((t) => t.kind === 'cash_in' && !NOT_OTHER.has(t.categoryId)).reduce((a, t) => a + t.amount, 0), txFrom)
    const expenses = perDay(mine.filter((t) => t.kind === 'cash_out' && t.origin !== 'payroll').reduce((a, t) => a + t.amount, 0), txFrom)
    const nights = perDay(rooms.sold, stayFrom)
    const months: BudgetMonth[] = Array.from({ length: 12 }, (_, i) => {
      const from = `${year}-${String(i + 1).padStart(2, '0')}-01`
      const days = daysBetween(from, addMonths(from, 1))
      const nudge = (k: number) => WOBBLE[(i + v * 3 + k) % WOBBLE.length] ?? 1
      return {
        roomNights: Math.min(units.length * days, Math.round(nights * days * nudge(0))),
        adr: round(rooms.adr * nudge(2), 10_000),
        otherRevenue: round(other * days * nudge(4), 100_000),
        expenses: round(expenses * days * nudge(5), 100_000),
      }
    })
    return { villaId: villa.id, year, months, updatedBy: by, updatedOn: `${year}-01-05` }
  })
}
