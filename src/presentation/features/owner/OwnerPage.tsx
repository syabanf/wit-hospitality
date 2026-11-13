import { Link, useNavigate, useSearchParams } from 'react-router'
import { ArrowDownRight, ArrowRight, ArrowUpRight, FileText } from 'lucide-react'
import { cn } from '@/lib/cn'
import { KindSplit } from '../shared/KindSplit'
import { shortMonth } from '@/lib/dates'
import { money, moneyCompact, percent } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { ColumnChart } from '../../charts/ColumnChart'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { LineChart } from '../../charts/LineChart'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { ViewToggle } from '../../ui/ViewToggle'
import { DonutLegend } from '../reports/DonutLegend'
import { ownerKey, parseOwner } from './filters'
import { BooksCard, KpiTiles, OwnerToolbar } from './parts'

const monthLabel = (m: string) => shortMonth(`${m}-01`)

/** The owner's view of performance and income: what was earned, where, and what changed. */
export default function OwnerPage() {
  const { performance, clock } = useServices()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [layout, setLayout] = useLayout()
  const state = parseOwner(params, clock.today())
  const data = useResource(`owner.overview:${ownerKey(state.filter)}`, () => performance.overview(state.filter))

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const keep = params.toString()
  const villaLink = (id: string) => `/owner/villas/${id}${keep ? `?${keep}` : ''}`
  const colour = (i: number) => seriesColor((i % 5) + 1)

  const villaTable = (
    <DataTable
      label="Profit by villa"
      rows={d.villas}
      rowKey={(v) => v.id}
      columns={[
        { key: 'v', header: 'Villa', cell: (v) => <Link to={villaLink(v.id)} className="font-medium hover:underline">{v.name}</Link> },
        { key: 'r', header: 'Revenue', align: 'right', cell: (v) => money(v.pnl.revenue + v.pnl.other) },
        { key: 'c', header: 'Costs', align: 'right', cell: (v) => money(v.pnl.fees + v.pnl.expenses + v.pnl.payroll) },
        { key: 'p', header: 'Profit', align: 'right', cell: (v) => money(v.pnl.profit) },
        { key: 'm', header: 'Margin', align: 'right', cell: (v) => percent(v.margin, { digits: 0 }) },
      ]}
      footer={['Total', money(d.villas.reduce((s, v) => s + v.pnl.revenue + v.pnl.other, 0)), money(d.villas.reduce((s, v) => s + v.pnl.fees + v.pnl.expenses + v.pnl.payroll, 0)), money(d.villas.reduce((s, v) => s + v.pnl.profit, 0)), '']}
    />
  )

  return (
    <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <OwnerToolbar state={state} catalog={d.catalog} />
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} />
          <Link to="/owner/statement" className={buttonStyles({ variant: 'accent' })}>
            <FileText aria-hidden className="size-4" /> Owner statement
          </Link>
        </div>
      </div>

      <KpiTiles kpis={d.kpis} />
      <KindSplit id="owner-kinds" rows={d.byKind.map((k) => ({ label: k.label, revenue: k.revenue, occupancy: k.occupancy, adr: k.adr, revpar: k.revpar }))} />

      {layout === 'table' ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card aria-labelledby="t-months">
            <CardHeader id="t-months" title="Last six months" />
            <DataTable
              label="Revenue, costs and profit per month"
              rows={d.trend}
              rowKey={(m) => m.month}
              columns={[
                { key: 'm', header: 'Month', cell: (m) => monthLabel(m.month) },
                { key: 'r', header: 'Revenue', align: 'right', cell: (m) => money(m.revenue) },
                { key: 'c', header: 'Costs', align: 'right', cell: (m) => money(m.costs) },
                { key: 'p', header: 'Profit', align: 'right', cell: (m) => money(m.profit) },
              ]}
            />
          </Card>
          <Card aria-labelledby="t-villas">
            <CardHeader id="t-villas" title="Profit by villa" />
            {villaTable}
          </Card>
          <Card aria-labelledby="t-sources">
            <CardHeader id="t-sources" title="Revenue by source" />
            <DataTable label="Revenue by source" rows={d.sources} rowKey={(s) => s.id} columns={[{ key: 's', header: 'Source', cell: (s) => s.label }, { key: 'v', header: 'Room revenue', align: 'right', cell: (s) => money(s.value) }]} />
          </Card>
          <Card aria-labelledby="t-costs">
            <CardHeader id="t-costs" title="Where the money goes" />
            <DataTable label="Costs" rows={d.costs} rowKey={(c) => c.id} columns={[{ key: 'c', header: 'Cost', cell: (c) => c.label }, { key: 'v', header: 'Amount', align: 'right', cell: (c) => money(c.value) }]} />
          </Card>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card aria-labelledby="c-months">
              <CardHeader id="c-months" title="Revenue, costs and profit per month" />
              <GroupedColumns
                label="Revenue, costs and profit per month"
                className="h-64"
                labels={d.trend.map((m) => monthLabel(m.month))}
                series={[
                  { id: 'revenue', label: 'Revenue', color: seriesColor(2) },
                  { id: 'costs', label: 'Costs', color: seriesColor(3) },
                  { id: 'profit', label: 'Profit', color: seriesColor(1) },
                ]}
                values={[d.trend.map((m) => m.revenue), d.trend.map((m) => m.costs), d.trend.map((m) => Math.max(0, m.profit))]}
                format={moneyCompact}
              />
            </Card>
            <Card aria-labelledby="c-profit">
              <CardHeader id="c-profit" title="Profit trend" />
              <LineChart
                label="Net income per month"
                height={256}
                labels={d.trend.map((m) => monthLabel(m.month))}
                series={[{ id: 'profit', label: 'Net income', values: d.trend.map((m) => Math.max(0, m.profit)), color: seriesColor(1), area: true }]}
                format={money}
                tick={moneyCompact}
              />
            </Card>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card aria-labelledby="c-villas">
              <CardHeader id="c-villas" title="Villas by profit" />
              <p className="-mt-2 mb-3 text-xs text-muted">Pick a column to open that villa.</p>
              <ColumnChart
                label="Profit by villa"
                className="h-56"
                data={d.villas.map((v) => ({ key: v.id, label: v.name.replace(/^Villa /, ''), value: Math.max(0, v.pnl.profit) }))}
                selected={null}
                onSelect={(id) => navigate(villaLink(id))}
                format={money}
                tick={moneyCompact}
              />
              <ul className="mt-4 divide-y divide-line">
                {d.villas.map((v) => (
                  <li key={v.id}>
                    <Link to={villaLink(v.id)} className="flex items-center gap-3 py-2.5 text-sm hover:text-fg">
                      <span className="min-w-0 flex-1 truncate font-medium">{v.name}</span>
                      <span className="text-xs text-muted tabular">{percent(v.margin, { digits: 0 })} margin</span>
                      <span className="font-semibold tabular">{money(v.pnl.profit)}</span>
                      <ArrowRight aria-hidden className="size-4 text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
            <div className="grid grid-cols-1 gap-4">
              <Card aria-labelledby="c-sources">
                <CardHeader id="c-sources" title="Revenue mix" />
                <DonutLegend label="Room revenue by source, and room service" format={moneyCompact} slices={[...d.sources, ...(d.roomService.sales > 0 ? [{ id: 'room-service', label: 'Room service', value: d.roomService.sales }] : [])].map((s, i) => ({ ...s, color: colour(i) }))} />
                {d.roomService.sales > 0 && (
                  <p className="mt-3 text-xs text-muted">
                    Room service sold {moneyCompact(d.roomService.sales)}, {moneyCompact(d.roomService.margin)} after partner costs.{' '}
                    <Link to="/reports/rs-revenue" className="text-accent-text hover:underline">
                      Report
                    </Link>
                  </p>
                )}
              </Card>
              <Card aria-labelledby="c-costs">
                <CardHeader id="c-costs" title="Where the money goes" />
                <DonutLegend label="Costs by kind" format={moneyCompact} slices={d.costs.slice(0, 6).map((c, i) => ({ ...c, color: colour(i) }))} />
              </Card>
            </div>
          </div>
        </>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <BooksCard books={d.books} />
        <Card aria-labelledby="changes-title">
          <CardHeader id="changes-title" title="What changed" />
          {d.changes.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Profit did not move against the comparison period.</p>
          ) : (
            <ul className="stagger space-y-2">
              {d.changes.map((c) => {
                const Icon = c.effect >= 0 ? ArrowUpRight : ArrowDownRight
                return (
                  <li key={c.key} className="flex items-start gap-3 rounded-panel bg-raised p-3 text-sm">
                    <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', c.effect >= 0 ? 'text-success' : 'text-danger')} />
                    <span className="min-w-0">{c.text}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
