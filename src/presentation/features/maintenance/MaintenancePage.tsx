import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, CalendarClock, Plus, Sparkles } from 'lucide-react'
import { HOUSEKEEPING_LABEL, PLAN_STATE_LABEL, PRIORITY_LABEL, WORK_ORDER_STATUS_LABEL } from '@/domain/maintenance'
import { shortDay } from '@/lib/dates'
import { money, moneyCompact } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { seriesColor } from '../../charts/colors'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { DonutLegend } from '../reports/DonutLegend'
import { HOUSEKEEPING_TONE, PLAN_TONE, PRIORITY_TONE, WORK_ORDER_SLOT } from './tones'

/** The maintenance desk: what is open and urgent, what falls due, which rooms are not ready, and what it costs. */
export default function MaintenancePage() {
  const { maintenance } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('maintenance.overview', () => maintenance.overview())
  const [villa, setVilla] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  async function generate() {
    setGenerating(true)
    try {
      const created = await maintenance.generateDue(7)
      toast({ title: created.length ? `Opened ${created.length} preventive jobs` : 'Nothing falls due this week', description: created.map((w) => w.title).join(', ') || undefined })
      data.reload()
    } finally {
      setGenerating(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const selectedVilla = d.costByVilla.find((r) => r.villa.id === villa) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Repairs, preventive service and room readiness across every villa.</p>
        <div className="flex flex-wrap gap-2">
          {can('maintenance', 'create') && (
            <Button variant="card" loading={generating} onClick={() => void generate()}>
              <Sparkles aria-hidden className="size-4" /> Open due jobs
            </Button>
          )}
          <Link to="/housekeeping" className={buttonStyles({ variant: 'card' })}>
            Housekeeping board
          </Link>
          {can('maintenance', 'create') && (
            <Link to="/maintenance/work-orders/new" className={buttonStyles({ variant: 'accent' })}>
              <Plus aria-hidden className="size-4" /> New work order
            </Link>
          )}
        </div>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-3 min-[1600px]:grid-cols-5">
        <StatTile label="Open jobs" value={d.open} hint={`${d.late.length} past their date`} to="/maintenance/work-orders" />
        <StatTile label="Urgent or high" value={d.urgent.length} hint="Still open" to="/maintenance/work-orders?priority=urgent" />
        <StatTile label="Preventive overdue" value={d.overduePlans.length} hint={`${d.duePlans.length} due this week`} to="/maintenance/preventive" />
        <StatTile label="Rooms not ready" value={d.notReady.length} hint={`${d.notReadyArrivals.length} with a guest arriving`} to="/housekeeping" />
        <StatTile label="Cost this month" value={money(d.costMonth)} hint={`${d.blockedUnits} units blocked now`} to="/reports/maint-cost" className="col-span-2 min-[1600px]:col-span-1" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card aria-labelledby="mt-weeks">
          <CardHeader id="mt-weeks" title="Opened and closed per week" />
          <GroupedColumns
            label="Jobs opened and closed per week"
            className="h-64"
            labels={d.weeks.map((w) => w.label)}
            series={[
              { id: 'opened', label: 'Opened', color: seriesColor(1) },
              { id: 'closed', label: 'Closed', color: seriesColor(4) },
            ]}
            values={[d.weeks.map((w) => w.opened), d.weeks.map((w) => w.closed)]}
            format={(v) => String(v)}
          />
        </Card>
        <Card aria-labelledby="mt-status">
          <CardHeader id="mt-status" title="Jobs by status" />
          <DonutLegend
            label="Work orders by status"
            format={(v) => String(v)}
            slices={d.byStatus.filter((s) => s.count > 0).map((s) => ({ id: s.status, label: WORK_ORDER_STATUS_LABEL[s.status], value: s.count, color: seriesColor(WORK_ORDER_SLOT[s.status]) }))}
          />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card aria-labelledby="mt-cost">
          <CardHeader id="mt-cost" title="Cost by villa, 60 days" action={selectedVilla && <span className="text-sm font-semibold tabular">{selectedVilla.villa.name}: {money(selectedVilla.cost)}</span>} />
          <ColumnChart
            label="Maintenance cost by villa"
            className="h-60"
            data={d.costByVilla.map((r) => ({ key: r.villa.id, label: r.villa.name.replace('Villa ', ''), value: r.cost }))}
            selected={villa}
            onSelect={(k) => setVilla(k === villa ? null : k)}
            format={money}
            tick={moneyCompact}
          />
        </Card>
        <Card aria-labelledby="mt-ready">
          <CardHeader id="mt-ready" title="Not ready" action={<Link to="/housekeeping" className="flex items-center gap-1 text-sm text-accent-text hover:underline">Board <ArrowRight aria-hidden className="size-4" /></Link>} />
          {d.notReady.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Every room is ready.</p>
          ) : (
            <ul className="stagger divide-y divide-line">
              {d.notReady.map((r) => (
                <li key={r.place.unit.id} className="flex items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
                  <span className="w-14 shrink-0 font-mono font-medium">{r.place.unit.code}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{r.arrival ? `${r.arrival.guestName} arrives` : (r.blockingWorkOrder?.title ?? r.record?.note ?? r.place.villa.name)}</span>
                  <StatusPill tone={HOUSEKEEPING_TONE[r.state]}>{HOUSEKEEPING_LABEL[r.state]}</StatusPill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card aria-labelledby="mt-urgent">
          <CardHeader id="mt-urgent" title="Urgent and high" action={<Link to="/maintenance/work-orders" className="flex items-center gap-1 text-sm text-accent-text hover:underline">All <ArrowRight aria-hidden className="size-4" /></Link>} />
          {d.urgent.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Nothing urgent.</p>
          ) : (
            <ul className="stagger divide-y divide-line">
              {d.urgent.map((w) => (
                <li key={w.id}>
                  <Link to={`/maintenance/work-orders/${w.id}`} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="w-14 shrink-0 font-mono text-xs text-muted">{w.unitCode || w.villaName.replace('Villa ', '')}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{w.title}</span>
                      <span className="block truncate text-xs text-muted">{w.vendorName || w.assigneeName || 'Unassigned'} · {WORK_ORDER_STATUS_LABEL[w.status]}</span>
                    </span>
                    <Tag tone={PRIORITY_TONE[w.priority]}>{PRIORITY_LABEL[w.priority]}</Tag>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card aria-labelledby="mt-plans">
          <CardHeader id="mt-plans" title="Preventive due" action={<Link to="/maintenance/preventive" className="flex items-center gap-1 text-sm text-accent-text hover:underline">Plans <ArrowRight aria-hidden className="size-4" /></Link>} />
          {d.overduePlans.length + d.duePlans.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Nothing due this week.</p>
          ) : (
            <ul className="stagger divide-y divide-line">
              {[...d.overduePlans, ...d.duePlans].map((p) => (
                <li key={p.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <CalendarClock aria-hidden className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.title}</span>
                    <span className="block truncate text-xs text-muted">{p.vendorName || p.assigneeName || p.villaName} · due {shortDay(p.nextDue)}</span>
                  </span>
                  <Tag tone={PLAN_TONE[p.state]}>{PLAN_STATE_LABEL[p.state]}</Tag>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
