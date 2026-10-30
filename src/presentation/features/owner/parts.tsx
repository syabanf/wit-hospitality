import { useSearchParams } from 'react-router'
import { COMPARE_OPTIONS, OWNER_PERIODS, type Delta } from '@/domain/performance'
import type { Catalog } from '@/domain/property'
import { money, percent } from '@/lib/format'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Select } from '../../ui/Field'
import { StatTile } from '../../ui/StatTile'
import { ScopePicker } from '../shared/ScopePicker'
import { rangeLabel, withParams, type OwnerState } from './filters'

/** Period, comparison and (optionally) scope, written to the URL. */
export function OwnerToolbar({ state, catalog, scope = true }: { state: OwnerState; catalog?: Catalog; scope?: boolean }) {
  const { clock } = useServices()
  const [params, setParams] = useSearchParams()
  const set = (next: Record<string, string | undefined>) => setParams(withParams(params, next), { replace: true })
  const f = state.filter
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Period" tone="card" value={state.period} options={OWNER_PERIODS} onChange={(e) => set({ period: e.target.value, from: undefined, to: undefined })} />
        {state.period === 'custom' && <DateRangeFilter tone="card" today={clock.today()} label="Period" value={{ from: f.from, to: f.to }} onChange={(r) => set({ from: r.from, to: r.to })} />}
        <Select aria-label="Compare with" tone="card" value={state.compare} options={COMPARE_OPTIONS} onChange={(e) => set({ compare: e.target.value })} />
        {scope && catalog && (
          <ScopePicker
            catalog={catalog}
            units={false}
            tone="card"
            value={{ locationId: f.locationId, villaId: f.villaId }}
            onChange={(s) => set({ location: s.locationId, villa: s.villaId })}
            className="flex min-w-0 flex-1 basis-72 gap-2"
          />
        )}
      </div>
      <p className="text-xs text-muted">
        {rangeLabel(f.from, f.to)}, compared with {rangeLabel(f.compareFrom, f.compareTo)}
      </p>
    </div>
  )
}

interface Kpis {
  profit: Delta
  revenue: Delta
  room: Delta
  margin: Delta
  occupancy: Delta
  adr: Delta
  revpar: Delta
  cash: number
}

const was = (d: Delta, fmt: (v: number) => string) => `was ${fmt(d.previous)}`

/** The eight numbers an owner reads first, each with its change. */
export function KpiTiles({ kpis }: { kpis: Kpis }) {
  const pct = (v: number) => percent(v, { digits: 0 })
  return (
    <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Net income" value={money(kpis.profit.value)} change={kpis.profit.change} hint={was(kpis.profit, money)} to="/reports/pnl-portfolio" />
      <StatTile label="Total revenue" value={money(kpis.revenue.value)} change={kpis.revenue.change} hint={was(kpis.revenue, money)} to="/reports/income" />
      <StatTile label="Room revenue" value={money(kpis.room.value)} change={kpis.room.change} hint={was(kpis.room, money)} to="/reports/revenue-source" />
      <StatTile label="Operating margin" value={pct(kpis.margin.value)} change={kpis.margin.change} hint={was(kpis.margin, pct)} to="/reports/pnl-villa" />
      <StatTile label="Occupancy" value={pct(kpis.occupancy.value)} change={kpis.occupancy.change} hint={was(kpis.occupancy, pct)} to="/reports/occupancy" />
      <StatTile label="ADR" value={money(kpis.adr.value)} change={kpis.adr.change} hint="Room revenue per night sold" to="/reports/occupancy" />
      <StatTile label="RevPAR" value={money(kpis.revpar.value)} change={kpis.revpar.change} hint="Room revenue per night available" to="/reports/occupancy" />
      <StatTile label="Cash balance" value={money(kpis.cash)} hint="Posted entries, accounts in scope" to="/finance" />
    </div>
  )
}

/** Confirmed revenue and occupancy already booked for the coming 30, 60 and 90 nights. */
export function BooksCard({ books }: { books: ReadonlyArray<{ days: number; revenue: number; nights: number; occupancy: number }> }) {
  return (
    <Card aria-labelledby="books-title">
      <CardHeader id="books-title" title="On the books" />
      <ul className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
        {books.map((b) => (
          <li key={b.days} className="min-w-0 rounded-panel bg-raised p-3.5">
            <p className="text-xs text-muted">Next {b.days} nights</p>
            <p className="mt-1.5 text-xl font-medium tracking-tight break-words tabular">{money(b.revenue)}</p>
            <p className="mt-1 text-xs text-muted tabular">
              {b.nights} nights, {percent(b.occupancy, { digits: 0 })} occupancy
            </p>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-control">
              <span className="block h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${Math.min(100, b.occupancy * 100)}%` }} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">Confirmed and in-house stays only; drafts and cancellations are left out.</p>
    </Card>
  )
}
