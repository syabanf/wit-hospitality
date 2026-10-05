import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import type { DashboardFilter } from '@/application/views'
import { PERIOD_LABEL } from '@/domain/dashboard'
import { cn } from '@/lib/cn'
import { addDays, shortDay } from '@/lib/dates'
import { money, moneyCompact, percent, plural } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { seriesColor } from '../../charts/colors'
import { Donut } from '../../charts/Donut'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import type { Layout } from '../../hooks/useLayout'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { BookingRows } from '../shared/BookingRows'
import { BookingTable } from '../shared/BookingTable'
import { filterKey } from './filters'

/** Revenue, occupancy, rate and nights for the owner, with the revenue series against targets. */
export function ExecutiveView({ filter, layout }: { filter: DashboardFilter; layout: Layout }) {
  const { dashboard } = useServices()
  const data = useResource(`dashboard.executive:${filterKey(filter)}`, () => dashboard.executive(filter))
  const [selected, setSelected] = useState<string | null>(null)
  const [activeSource, setActiveSource] = useState<string | null>(null)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeleton key={i} lines={1} />
        ))}
        <CardSkeleton className="md:col-span-2 xl:col-span-3" lines={6} />
        <CardSkeleton lines={6} />
      </div>
    )
  }

  const d = data.data
  const periodLabel = filter.from || filter.to ? `${shortDay(d.range.from)} to ${shortDay(addDays(d.range.to, -1))}` : PERIOD_LABEL[filter.period]
  const selectedKey = d.series.some((s) => s.key === selected) ? selected : (d.series.at(-1)?.key ?? null)
  const sourceTotal = d.sources.reduce((s, x) => s + x.value, 0)
  const maxOcc = Math.max(0.01, ...d.byLocation.map((l) => l.occupancy))
  const scopeQuery = new URLSearchParams()
  if (filter.locationId) scopeQuery.set('location', filter.locationId)
  if (filter.villaId) scopeQuery.set('villa', filter.villaId)
  if (filter.unitId) scopeQuery.set('unit', filter.unitId)
  const calendarTo = `/calendar${scopeQuery.size ? `?${scopeQuery}` : ''}`

  const tiles = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label={`Room revenue, ${periodLabel}`} value={money(d.revenue.value)} change={d.revenue.change} hint={`vs ${money(d.revenue.previous)} before`} to="/finance" />
      <StatTile label="Occupancy" value={percent(d.occupancy.value, { digits: 0 })} change={d.occupancy.change} hint={`${plural(d.unitCount, 'unit')} in scope`} to={calendarTo} />
      <StatTile label="Average nightly rate" value={money(d.adr.value)} change={d.adr.change} hint="Revenue over nights sold" to="/bookings" />
      <StatTile label="Nights sold" value={d.nightsSold.value} change={d.nightsSold.change} hint={`vs ${d.nightsSold.previous} before`} to="/bookings" />
    </div>
  )

  if (layout === 'table') {
    return (
      <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
        {tiles}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card aria-labelledby="exec-t-revenue">
            <CardHeader id="exec-t-revenue" title={`Revenue per ${filter.period === '7d' ? 'day' : 'week'}`} />
            <DataTable
              label="Revenue per period"
              rows={d.series}
              rowKey={(s) => s.key}
              columns={[
                { key: 'p', header: 'Period', cell: (s) => s.label },
                { key: 'r', header: 'Revenue', align: 'right', cell: (s) => money(s.revenue) },
                { key: 't', header: 'Target', align: 'right', cell: (s) => money(s.target) },
                { key: 'pct', header: 'Reached', align: 'right', cell: (s) => (s.target ? percent(s.revenue / s.target, { digits: 0 }) : 'No target') },
              ]}
              footer={['Total', money(d.revenue.value), money(d.series.reduce((t, s) => t + s.target, 0)), `${d.onTarget} of ${d.series.length} on target`]}
            />
          </Card>
          <div className="space-y-4">
            <Card aria-labelledby="exec-t-sources">
              <CardHeader id="exec-t-sources" title="Revenue by source" />
              <DataTable
                label="Revenue by source"
                rows={d.sources}
                rowKey={(s) => s.id}
                columns={[
                  { key: 's', header: 'Source', cell: (s) => <Link to={`/bookings?source=${s.id}`} className="hover:underline">{s.label}</Link> },
                  { key: 'r', header: 'Revenue', align: 'right', cell: (s) => money(s.value) },
                  { key: 'sh', header: 'Share', align: 'right', cell: (s) => percent(sourceTotal ? s.value / sourceTotal : 0, { digits: 0 }) },
                ]}
                footer={['Total', money(sourceTotal), '100%']}
              />
            </Card>
            <Card aria-labelledby="exec-t-locations">
              <CardHeader id="exec-t-locations" title="Occupancy by location" />
              <DataTable
                label="Occupancy by location"
                rows={d.byLocation}
                rowKey={(r) => r.location.id}
                columns={[
                  { key: 'l', header: 'Location', cell: (r) => <Link to={`/property?location=${r.location.id}`} className="hover:underline">{r.location.name}</Link> },
                  { key: 'u', header: 'Units', align: 'right', cell: (r) => r.units },
                  { key: 'o', header: 'Occupancy', align: 'right', cell: (r) => percent(r.occupancy, { digits: 0 }) },
                  { key: 'r', header: 'Revenue', align: 'right', cell: (r) => money(r.revenue) },
                ]}
              />
            </Card>
          </div>
        </div>
        <Card className="p-0" aria-labelledby="exec-t-upcoming">
          <div className="p-5 pb-0">
            <CardHeader id="exec-t-upcoming" title="Arriving in the next 7 days" />
          </div>
          <BookingTable label="Arriving in the next 7 days" rows={d.upcoming} exportName="arrivals" exportDate={d.range.to} />
        </Card>
      </div>
    )
  }

  return (
    <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
      {tiles}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card className="md:col-span-2" aria-labelledby="exec-revenue">
          <CardHeader
            id="exec-revenue"
            title="Revenue"
            action={
              <p className="flex items-center gap-2 text-xs text-muted">
                <span aria-hidden className="inline-block h-[3px] w-4 rounded-full bg-fg/85" />
                Target at 70% occupancy · {d.onTarget} of {d.series.length} on target
              </p>
            }
          />
          <ColumnChart
            label={`Revenue per ${d.series.length && d.series[0] && d.series[0].to === addDays(d.series[0].from, 1) ? 'day' : 'week'}`}
            className="h-64 lg:h-72"
            data={d.series.map((s) => ({ key: s.key, label: s.label, value: s.revenue, target: s.target }))}
            selected={selectedKey}
            onSelect={setSelected}
            showTargets
            format={moneyCompact}
            tick={moneyCompact}
            badge={(datum) => (datum.target && datum.target > 0 ? percent(datum.value / datum.target, { digits: 0 }) : 'No target')}
          />
        </Card>

        <Card aria-labelledby="exec-sources">
          <CardHeader id="exec-sources" title="Revenue by source" />
          {d.sources.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No revenue in this scope.</p>
          ) : (
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start xl:flex-col xl:items-center">
              <Donut
                label="Revenue by booking source"
                size={180}
                slices={d.sources.map((s) => ({ id: s.id, label: s.label, value: s.value, color: seriesColor(s.slot) }))}
                active={activeSource}
                onActive={setActiveSource}
                chip={(s) => `${s.label}: ${moneyCompact(s.value)} (${percent(s.value / sourceTotal, { digits: 0 })})`}
              >
                <p className="text-[22px] leading-none font-medium tracking-tight tabular">{moneyCompact(sourceTotal)}</p>
                <p className="mt-1 text-xs text-muted">{periodLabel}</p>
              </Donut>
              <ul className="w-full space-y-1">
                {d.sources.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={`/bookings?source=${s.id}`}
                      onPointerEnter={() => setActiveSource(s.id)}
                      onPointerLeave={() => setActiveSource(null)}
                      onFocus={() => setActiveSource(s.id)}
                      onBlur={() => setActiveSource(null)}
                      className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors hover:bg-raised', activeSource === s.id && 'bg-raised')}
                    >
                      <span aria-hidden className="size-2.5 rounded-full" style={{ background: seriesColor(s.slot) }} />
                      <span className="flex-1 truncate">{s.label}</span>
                      <span className="font-medium tabular">{percent(s.value / sourceTotal, { digits: 0 })}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="md:col-span-2 xl:col-span-1" aria-labelledby="exec-locations">
          <CardHeader id="exec-locations" title="Occupancy by location" />
          <ul className="space-y-3">
            {d.byLocation.map((row) => (
              <li key={row.location.id}>
                <Link to={`/property?location=${row.location.id}`} className="block rounded-xl px-2 py-1.5 transition-colors hover:bg-raised">
                  <span className="flex items-center justify-between text-sm">
                    <span className="font-medium">{row.location.name}</span>
                    <span className="text-muted">
                      {plural(row.units, 'unit')} · <span className="font-medium text-fg tabular">{percent(row.occupancy, { digits: 0 })}</span>
                    </span>
                  </span>
                  <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-control">
                    <span className={cn('block h-full rounded-full', row.occupancy === maxOcc ? 'bg-accent' : 'bg-fg/70')} style={{ width: `${(row.occupancy / maxOcc) * 100}%` }} />
                  </span>
                  <span className="mt-1 block text-xs text-muted tabular">{money(row.revenue)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="md:col-span-2" aria-labelledby="exec-upcoming">
          <CardHeader
            id="exec-upcoming"
            title="Arriving in the next 7 days"
            action={
              <Link to="/bookings?status=confirmed" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                All confirmed <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          />
          <BookingRows bookings={d.upcoming} empty="No arrivals in the next week for this scope." />
        </Card>
      </div>
    </div>
  )
}
