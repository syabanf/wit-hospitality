import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, LogIn, LogOut } from 'lucide-react'
import type { DashboardFilter, ServiceRequestView } from '@/application/views'
import { nextServiceStep, SERVICE_KIND_LABEL } from '@/domain/roomService'
import { BLOCK_REASON_LABEL } from '@/domain/booking'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { count, plural } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { LineChart } from '../../charts/LineChart'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import type { Layout } from '../../hooks/useLayout'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { BookingRows } from '../shared/BookingRows'
import { BookingTable } from '../shared/BookingTable'
import { RequestRows } from '../shared/RequestRows'
import { filterKey } from './filters'

/** Today's arrivals, departures and in-house guests, with check-in and check-out in place. */
export function OperationalView({ filter, layout }: { filter: DashboardFilter; layout: Layout }) {
  const { dashboard, service } = useServices()
  const toast = useToast()
  const data = useResource(`dashboard.operational:${filterKey(filter)}`, () => dashboard.operational(filter))
  const [busy, setBusy] = useState<string | null>(null)

  async function advance(r: ServiceRequestView) {
    const step = nextServiceStep(r)
    if (!step) return
    setBusy(r.id)
    try {
      await service.transition(r.id, step)
      toast({ title: step === 'done' ? `Closed ${r.number}` : `Started ${r.number}`, description: `${r.unitCode} · ${SERVICE_KIND_LABEL[r.kind]}` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${r.number}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <CardSkeleton key={i} lines={1} />
        ))}
        <CardSkeleton className="md:col-span-2 xl:col-span-3" lines={5} />
        <CardSkeleton className="md:col-span-2" lines={5} />
      </div>
    )
  }
  const d = data.data
  const attention = d.lateArrivals.length + d.overstays.length

  const tiles = (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatTile label="Arrivals today" value={d.arrivals.length} hint={d.lateArrivals.length ? `${d.lateArrivals.length} not yet arrived` : 'All on schedule'} to="/bookings?status=confirmed" />
      <StatTile label="Departures today" value={d.departures.length} hint={d.overstays.length ? `${d.overstays.length} past check-out` : 'Rooms turn over'} to="/bookings?status=checked_in" />
      <StatTile label="In house" value={d.inHouse.length} hint={plural(d.units, 'unit')} to="/bookings?status=checked_in" />
      <StatTile label="Free tonight" value={d.available} hint="Sellable units" to="/calendar" />
      <StatTile label="Open requests" value={d.requests.length} hint={`${d.requests.filter((r) => r.priority === 'urgent').length} urgent`} to="/services" className="col-span-2 sm:col-span-1" />
    </div>
  )

  if (layout === 'table') {
    const sections = [
      { id: 'arrivals', title: 'Arrivals', rows: [...d.lateArrivals, ...d.arrivals] },
      { id: 'departures', title: 'Departures', rows: [...d.overstays, ...d.departures] },
      { id: 'inhouse', title: 'In house', rows: d.inHouse },
    ]
    return (
      <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
        {tiles}
        {sections.map((s) => (
          <Card key={s.id} className="p-0" aria-labelledby={`ops-t-${s.id}`}>
            <div className="p-5 pb-0">
              <CardHeader id={`ops-t-${s.id}`} title={s.title} action={<span className="text-xs text-muted">{plural(s.rows.length, 'stay')}</span>} />
            </div>
            <BookingTable label={s.title} rows={s.rows} exportName={s.id} exportDate={d.today} />
          </Card>
        ))}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card aria-labelledby="ops-t-strip">
            <CardHeader id="ops-t-strip" title="Occupied units, next 14 nights" />
            <DataTable
              label="Occupied units per night"
              rows={d.days.map((day, i) => ({ day, total: d.strip.total[i] ?? 0, per: d.strip.byLocation.map((row) => row.values[i] ?? 0) }))}
              rowKey={(r) => r.day}
              columns={[
                { key: 'd', header: 'Night', cell: (r) => shortDay(r.day) },
                { key: 't', header: 'Total', align: 'right', cell: (r) => `${r.total} / ${d.units}` },
                ...d.strip.byLocation.map((row, i) => ({ key: row.location.id, header: row.location.name, align: 'right' as const, cell: (r: { per: number[] }) => r.per[i] ?? 0 })),
              ]}
            />
          </Card>
          <Card className="xl:col-span-2" aria-labelledby="ops-t-requests">
            <CardHeader id="ops-t-requests" title="Open room-service requests" action={<Link to="/services" className="text-sm text-accent-text hover:underline">All requests</Link>} />
            <RequestRows requests={d.requests} today={d.today} busy={busy} onAdvance={(r) => void advance(r)} empty="No open requests." />
          </Card>
          <Card aria-labelledby="ops-t-blocks">
            <CardHeader id="ops-t-blocks" title="Blocked units" />
            {d.blocks.length === 0 ? (
              <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No blocks ahead.</p>
            ) : (
              <DataTable
                label="Blocks"
                rows={d.blocks}
                rowKey={(k) => k.id}
                columns={[
                  { key: 'u', header: 'Unit', cell: (k) => <Link to={`/property/units/${k.unitId}`} className="font-mono hover:underline">{k.place.unit.code}</Link> },
                  { key: 'r', header: 'Reason', cell: (k) => BLOCK_REASON_LABEL[k.reason] },
                  { key: 'f', header: 'From', cell: (k) => shortDay(k.from) },
                  { key: 't', header: 'To', cell: (k) => shortDay(k.to) },
                  { key: 'n', header: 'Note', cell: (k) => k.note },
                ]}
              />
            )}
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
      {tiles}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card aria-labelledby="ops-arrivals">
          <CardHeader id="ops-arrivals" title="Arrivals" />
          <BookingRows
            bookings={[...d.lateArrivals, ...d.arrivals]}
            empty="Nobody arrives today."
            trailing={(b) => (
              <Link to={`/bookings/${b.id}?desk=in`} className={buttonStyles({ variant: b.checkIn < d.today ? 'accent' : 'solid', size: 'sm' })}>
                <LogIn aria-hidden className="size-3.5" /> Check in
              </Link>
            )}
          />
        </Card>
        <Card aria-labelledby="ops-departures">
          <CardHeader id="ops-departures" title="Departures" />
          <BookingRows
            bookings={[...d.overstays, ...d.departures]}
            empty="Nobody leaves today."
            trailing={(b) => (
              <Link to={`/bookings/${b.id}?desk=out`} className={buttonStyles({ variant: 'soft', size: 'sm' })}>
                <LogOut aria-hidden className="size-3.5" /> Check out
              </Link>
            )}
          />
        </Card>
        <Card className="md:col-span-2 xl:col-span-1" aria-labelledby="ops-inhouse">
          <CardHeader
            id="ops-inhouse"
            title="In house"
            action={
              <Link to="/bookings?status=checked_in" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                All <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          />
          <BookingRows bookings={d.inHouse.filter((b) => !d.departures.includes(b) && !d.overstays.includes(b)).slice(0, 6)} empty="No guests in house." />
        </Card>

        <Card className="md:col-span-2" aria-labelledby="ops-strip">
          <CardHeader
            id="ops-strip"
            title="Occupied units, next 14 nights"
            action={
              <ul className="flex flex-wrap gap-3 text-xs text-muted">
                <li className="flex items-center gap-1.5">
                  <span aria-hidden className="inline-block h-0.5 w-3 rounded-full bg-fg" /> Total
                </li>
                {d.strip.byLocation.map((row, i) => (
                  <li key={row.location.id} className="flex items-center gap-1.5">
                    <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: seriesColor(i + 1) }} /> {row.location.name}
                  </li>
                ))}
              </ul>
            }
          />
          <LineChart
            label="Occupied units per night"
            labels={d.strip.labels}
            format={(v) => plural(Math.round(v), 'unit')}
            tick={(v) => count(v)}
            max={d.units}
            height={220}
            series={[
              { id: 'total', label: 'Total', values: d.strip.total, color: 'var(--color-fg)', area: true },
              ...d.strip.byLocation.map((row, i) => ({ id: row.location.id, label: row.location.name, values: row.values, color: seriesColor(i + 1), muted: true })),
            ]}
          />
        </Card>

        <Card className="md:col-span-2 xl:col-span-2" aria-labelledby="ops-requests">
          <CardHeader id="ops-requests" title="Room services" action={<Link to="/services" className="flex items-center gap-1 text-sm text-accent-text hover:underline">All requests <ArrowRight aria-hidden className="size-4" /></Link>} />
          <RequestRows requests={d.requests.slice(0, 6)} today={d.today} busy={busy} onAdvance={(r) => void advance(r)} empty="No open requests." />
        </Card>

        <Card aria-labelledby="ops-blocks">
          <CardHeader id="ops-blocks" title="Blocked units" action={attention > 0 && <span className="text-xs font-semibold text-accent-text">{attention} need attention</span>} />
          {d.blocks.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No blocks ahead.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.blocks.map((k) => (
                <li key={k.id}>
                  <Link to={`/property/units/${k.unitId}`} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="hatch grid size-10 shrink-0 place-items-center rounded-xl border border-line-strong bg-control text-xs font-semibold">{k.place.unit.code.split('-')[1]}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {k.place.unit.code} · {BLOCK_REASON_LABEL[k.reason]}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {shortDay(k.from)} to {shortDay(k.to)}
                        {k.note && ` · ${k.note}`}
                      </span>
                    </span>
                    <ArrowRight aria-hidden className="size-4 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
