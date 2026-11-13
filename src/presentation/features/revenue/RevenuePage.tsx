import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Calculator, FileBarChart } from 'lucide-react'
import type { RevenueFilter } from '@/application/revenue'
import { FORECAST_METHOD, SEGMENT_LABEL, SEGMENTS, type RoomStats } from '@/domain/revenue'
import { cn } from '@/lib/cn'
import { shortMonth } from '@/lib/dates'
import { count, money, moneyCompact, percent } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { ColumnChart } from '../../charts/ColumnChart'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Select } from '../../ui/Field'
import { StatTile } from '../../ui/StatTile'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { ownerKey, parseOwner, rangeLabel, withParams } from '../owner/filters'
import { KindSplit } from '../shared/KindSplit'
import { OwnerToolbar } from '../owner/parts'
import { DonutLegend } from '../reports/DonutLegend'

const monthLabel = (m: string) => shortMonth(`${m}-01`)
const pct = (v: number) => percent(v, { digits: 1 })
const NO_DATA = 'No data'

/** The rows of the statistics card and how each prints. */
const STATS: ReadonlyArray<{ label: string; show: (s: RoomStats) => string }> = [
  { label: 'Rooms available', show: (s) => count(s.available) },
  { label: 'Rooms sold', show: (s) => count(s.sold) },
  { label: 'Occupancy', show: (s) => pct(s.occupancy) },
  { label: 'ADR', show: (s) => money(s.adr) },
  { label: 'RevPAR', show: (s) => money(s.revpar) },
  { label: 'Room revenue', show: (s) => money(s.revenue) },
  { label: 'Average stay', show: (s) => `${s.alos.toFixed(1)} nights` },
  { label: 'Booking lead time', show: (s) => `${Math.round(s.leadTime)} days` },
  { label: 'Cancellation rate', show: (s) => pct(s.cancellationRate) },
  { label: 'No-show rate', show: (s) => pct(s.noShowRate) },
]

const SORTS = [
  { value: 'revpar', label: 'Sort by RevPAR' },
  { value: 'occupancy', label: 'Sort by occupancy' },
  { value: 'adr', label: 'Sort by ADR' },
  { value: 'revenue', label: 'Sort by revenue' },
] as const
type SortKey = (typeof SORTS)[number]['value']

/** Revenue management for the portfolio, a location or a villa: KPIs, statistics, trend, pace, mix and villas. */
export default function RevenuePage() {
  const { revenue, clock } = useServices()
  const [params, setParams] = useSearchParams()
  const state = parseOwner(params, clock.today())
  const segment = SEGMENTS.find((s) => s === params.get('source'))
  const filter: RevenueFilter = { from: state.filter.from, to: state.filter.to, compare: state.compare, locationId: state.filter.locationId, villaId: state.filter.villaId, segment }
  const data = useResource(`revenue.dashboard:${ownerKey(state.filter)}|${state.compare}|${segment ?? ''}`, () => revenue.dashboard(filter))
  const [picked, setPicked] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortKey>('revpar')

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const month = d.trend.find((m) => m.month === picked) ?? d.trend.at(-1)
  const villas = [...d.villas].sort((a, b) => b[sortBy] - a[sortBy])
  const tile = (k: { value: number; previous: number | null; change: number | null }, fmt: (v: number) => string) => ({
    value: fmt(k.value),
    change: k.previous === null ? undefined : k.change,
    hint: k.previous === null ? `${NO_DATA} for ${rangeLabel(d.compare.from, d.compare.to)}` : `was ${fmt(k.previous)}`,
  })

  return (
    <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <OwnerToolbar state={state} catalog={d.catalog} />
          <Select
            aria-label="Source"
            tone="card"
            value={segment ?? ''}
            options={[{ value: '', label: 'All sources' }, ...SEGMENTS.map((s) => ({ value: s, label: SEGMENT_LABEL[s] }))]}
            onChange={(e) => setParams(withParams(params, { source: e.target.value }), { replace: true })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/reports?group=revenue" className={buttonStyles({ variant: 'card' })}>
            <FileBarChart aria-hidden className="size-4" /> Reports
          </Link>
          <Link to="/revenue/budget" className={buttonStyles({ variant: 'accent' })}>
            <Calculator aria-hidden className="size-4" /> Budget
          </Link>
        </div>
      </div>

      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Occupancy" {...tile(d.kpis.occupancy, pct)} to="/reports/rm-daily" />
        <StatTile label="ADR" {...tile(d.kpis.adr, money)} to="/reports/rm-monthly" />
        <StatTile label="RevPAR" {...tile(d.kpis.revpar, money)} to="/reports/rm-monthly" />
        <StatTile label="Room revenue" {...tile(d.kpis.revenue, money)} to="/reports/rm-daily" />
      </div>

      {d.kinds.length > 0 && <KindSplit id="rv-kinds" rows={[...d.kinds.map((k) => ({ label: k.label, ...k.stats })), { label: 'Total', ...d.current }]} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card aria-labelledby="rv-trend">
          <CardHeader id="rv-trend" title="Room revenue, last 12 months" />
          <ColumnChart
            label="Room revenue per month"
            className="h-60"
            data={d.trend.map((m) => ({ key: m.month, label: monthLabel(m.month), value: m.revenue }))}
            selected={month?.month ?? null}
            onSelect={setPicked}
            format={money}
            tick={moneyCompact}
          />
          {month && (
            <p className="mt-3 text-sm text-muted">
              {monthLabel(month.month)}: {month.hasData ? `${pct(month.occupancy)} occupancy, ADR ${money(month.adr)}, RevPAR ${money(month.revpar)}, ${count(month.sold)} nights sold.` : `${NO_DATA}: the records start later.`}
            </p>
          )}
        </Card>
        <Card aria-labelledby="rv-mix">
          <CardHeader id="rv-mix" title="Source mix" />
          <DonutLegend label="Room revenue by source" format={moneyCompact} slices={d.mix.filter((m) => m.value > 0).map((m, i) => ({ ...m, color: seriesColor(i + 1) }))} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card aria-labelledby="rv-stats">
          <CardHeader id="rv-stats" title="Statistics" />
          <DataTable
            label="Revenue statistics"
            rows={STATS}
            rowKey={(r) => r.label}
            columns={[
              { key: 'l', header: 'Measure', cell: (r) => r.label },
              { key: 'c', header: 'This period', align: 'right', cell: (r) => r.show(d.current) },
              { key: 'p', header: 'Compared', align: 'right', cell: (r) => (d.previous ? r.show(d.previous) : <span className="text-muted">{NO_DATA}</span>) },
              { key: 'y', header: 'Last year', align: 'right', cell: (r) => (d.lastYear ? r.show(d.lastYear) : <span className="text-muted">{NO_DATA}</span>) },
            ]}
          />
          <p className="mt-3 text-xs text-muted">
            {rangeLabel(d.range.from, d.range.to)}, compared with {rangeLabel(d.compare.from, d.compare.to)} and {rangeLabel(d.lastYearRange.from, d.lastYearRange.to)}. Rooms available are unit nights less blocked nights; drafts and cancellations are not sold.
          </p>
        </Card>
        <Card aria-labelledby="rv-pace">
          <CardHeader id="rv-pace" title="Pace, next six months" />
          <GroupedColumns
            label="Room nights on the books, last month at the same lead, and forecast"
            className="h-56"
            labels={d.pace.map((p) => monthLabel(p.month))}
            series={[
              { id: 'books', label: 'On the books', color: seriesColor(1) },
              { id: 'last', label: 'Month before, same lead', color: seriesColor(3) },
              { id: 'forecast', label: 'Forecast', color: seriesColor(2) },
            ]}
            values={[d.pace.map((p) => p.onBooks.nights), d.pace.map((p) => p.lastMonthSameLead.nights), d.pace.map((p) => p.forecast.nights)]}
            format={count}
          />
          <DataTable
            className="mt-4"
            label="Pace and forecast by month"
            rows={d.pace}
            rowKey={(p) => p.month}
            columns={[
              { key: 'm', header: 'Month', cell: (p) => monthLabel(p.month) },
              { key: 'b', header: 'On the books', align: 'right', cell: (p) => `${count(p.onBooks.nights)} nights` },
              { key: 'p', header: 'Pace', align: 'right', cell: (p) => (p.pace === null ? <span className="text-muted">–</span> : <span className={p.pace >= 0 ? 'text-success' : 'text-danger'}>{percent(p.pace, { signed: true, digits: 0 })}</span>) },
              { key: 'f', header: 'Forecast', align: 'right', cell: (p) => `${pct(p.forecastOccupancy)}, ${moneyCompact(p.forecast.revenue)}` },
            ]}
          />
          <p className="mt-3 text-xs text-muted">{FORECAST_METHOD}</p>
        </Card>
      </div>

      <Card aria-labelledby="rv-villas">
        <CardHeader id="rv-villas" title="Villas" action={<Select aria-label="Sort villas" compact value={sortBy} options={SORTS} onChange={(e) => setSortBy(e.target.value as SortKey)} />} />
        <DataTable
          label="Villas by revenue performance"
          rows={villas}
          rowKey={(v) => v.id}
          columns={[
            { key: 'v', header: 'Villa', cell: (v) => <Link to={`/owner/villas/${v.id}`} className="font-medium hover:underline">{v.name}</Link> },
            { key: 'o', header: 'Occupancy', align: 'right', cell: (v) => pct(v.occupancy) },
            { key: 'a', header: 'ADR', align: 'right', cell: (v) => money(v.adr) },
            { key: 'r', header: 'RevPAR', align: 'right', cell: (v) => money(v.revpar) },
            { key: 'n', header: 'Revenue', align: 'right', cell: (v) => money(v.revenue) },
          ]}
        />
      </Card>
    </div>
  )
}
