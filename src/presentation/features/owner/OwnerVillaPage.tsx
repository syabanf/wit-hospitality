import { Link, useParams, useSearchParams } from 'react-router'
import { FileText, Wrench } from 'lucide-react'
import { cn } from '@/lib/cn'
import { KindSplit } from '../shared/KindSplit'
import { shortMonth } from '@/lib/dates'
import { money, moneyCompact, percent } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { ColumnChart } from '../../charts/ColumnChart'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Gate } from '../../ui/Gate'
import { Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { ownerKey, parseOwner } from './filters'
import { BooksCard, KpiTiles, OwnerToolbar } from './parts'

const monthLabel = (m: string) => shortMonth(`${m}-01`)

/** One villa through the owner's eyes: its numbers, its units, its months and its costs. */
export default function OwnerVillaPage() {
  const { id = '' } = useParams()
  const { performance, clock } = useServices()
  const [params] = useSearchParams()
  const state = parseOwner(params, clock.today())
  const resource = useResource(`owner.villa:${id}:${ownerKey(state.filter)}`, () => performance.villa(id, state.filter), { keepPrevious: false })
  const back = new URLSearchParams(params)
  back.delete('villa')

  return (
    <Gate resource={resource} what="villa" back={{ to: '/owner', label: 'Back to performance' }}>
      {(d) => (
        <>
          <PageBar
            fallback={`/owner?${back}`}
            label="Performance"
            actions={
              <Link to={`/owner/statement?villa=${d.villa.id}`} className={buttonStyles({ variant: 'accent' })}>
                <FileText aria-hidden className="size-4" /> Statement
              </Link>
            }
          />
          <div className={cn('space-y-4', resource.status === 'loading' && 'opacity-60 transition-opacity')}>
            <div>
              <Headline>{d.villa.name}</Headline>
              <p className="mt-1 mb-3 text-sm text-muted">
                {d.location.name} · {d.units.length} units
              </p>
              <OwnerToolbar state={state} scope={false} />
            </div>

            <KpiTiles kpis={d.kpis} />
            <KindSplit id="owner-kinds" rows={d.byKind.map((k) => ({ label: k.label, revenue: k.revenue, occupancy: k.occupancy, adr: k.adr, revpar: k.revpar }))} />

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card aria-labelledby="v-months">
                <CardHeader id="v-months" title="Last six months" />
                <GroupedColumns
                  label="Revenue, costs and profit per month"
                  className="h-56"
                  labels={d.months.map((m) => monthLabel(m.month))}
                  series={[
                    { id: 'revenue', label: 'Revenue', color: seriesColor(2) },
                    { id: 'costs', label: 'Costs', color: seriesColor(3) },
                    { id: 'profit', label: 'Profit', color: seriesColor(1) },
                  ]}
                  values={[d.months.map((m) => m.revenue + m.other), d.months.map((m) => m.fees + m.expenses + m.payroll), d.months.map((m) => Math.max(0, m.profit))]}
                  format={moneyCompact}
                />
              </Card>
              <Card aria-labelledby="v-units" className="overflow-hidden">
                <CardHeader id="v-units" title="Units by revenue" />
                <ColumnChart
                  label="Room revenue by unit"
                  className="h-56"
                  data={d.units.map((u) => ({ key: u.unit, label: u.unit, value: u.revenue }))}
                  selected={null}
                  onSelect={() => undefined}
                  format={money}
                  tick={moneyCompact}
                />
              </Card>
            </div>

            <Card aria-labelledby="v-pnl">
              <CardHeader id="v-pnl" title="Monthly profit and loss" />
              <DataTable
                  label="Monthly profit and loss"
                  rows={d.months}
                  rowKey={(m) => m.month}
                  columns={[
                    { key: 'm', header: 'Month', cell: (m) => monthLabel(m.month) },
                    { key: 'r', header: 'Room revenue', align: 'right', cell: (m) => money(m.revenue) },
                    { key: 'o', header: 'Other income', align: 'right', cell: (m) => money(m.other) },
                    { key: 'f', header: 'Airbnb fees', align: 'right', cell: (m) => money(-m.fees) },
                    { key: 'e', header: 'Expenses', align: 'right', cell: (m) => money(-m.expenses) },
                    { key: 'p', header: 'Payroll', align: 'right', cell: (m) => money(-m.payroll) },
                    { key: 'n', header: 'Profit', align: 'right', cell: (m) => <span className="font-semibold">{money(m.profit)}</span> },
                  ]}
                />
            </Card>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card aria-labelledby="v-unit-table">
                <CardHeader id="v-unit-table" title="Unit ranking" />
                <DataTable
                  label="Unit ranking"
                  rows={d.units}
                  rowKey={(u) => u.unit}
                  columns={[
                    { key: 'u', header: 'Unit', cell: (u) => <span className="font-mono">{u.unit}</span> },
                    { key: 'r', header: 'Revenue', align: 'right', cell: (u) => money(u.revenue) },
                    { key: 'o', header: 'Occupancy', align: 'right', cell: (u) => percent(u.occupancy, { digits: 0 }) },
                    { key: 'a', header: 'ADR', align: 'right', cell: (u) => money(u.adr) },
                  ]}
                />
              </Card>
              <Card aria-labelledby="v-expenses">
                <CardHeader id="v-expenses" title="Top expenses" />
                {d.expenses.length === 0 ? (
                  <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No posted expenses in the period.</p>
                ) : (
                  <ul className="stagger divide-y divide-line">
                    {d.expenses.slice(0, 6).map((e) => (
                      <li key={e.category} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                        <span className="min-w-0 truncate">{e.category}</span>
                        <span className="text-xs text-muted tabular">{e.entries} entries</span>
                        <span className="font-semibold tabular">{money(e.amount)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <Link to={`/reports/maint-cost?villa=${d.villa.id}`} className="mt-4 flex items-center gap-3 rounded-panel bg-raised p-3 text-sm hover:bg-control">
                  <Wrench aria-hidden className="size-4 text-muted" />
                  <span className="min-w-0 flex-1">
                    Maintenance jobs: {d.maintenance.jobs}, {d.maintenance.open} still open
                  </span>
                  <span className="font-semibold tabular">{money(d.maintenance.total)}</span>
                </Link>
              </Card>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <Card aria-labelledby="v-payroll">
                <CardHeader id="v-payroll" title="Payroll allocated to this villa" />
                {d.payroll.length === 0 ? (
                  <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No payroll period in the range.</p>
                ) : (
                  <DataTable
                    label="Payroll allocation"
                    rows={d.payroll}
                    rowKey={(p) => p.period}
                    columns={[
                      { key: 'p', header: 'Period', cell: (p) => p.period },
                      { key: 's', header: 'Status', cell: (p) => p.status },
                      { key: 'e', header: 'Employees', align: 'right', cell: (p) => p.employees },
                      { key: 'c', header: 'Cost', align: 'right', cell: (p) => money(p.cost) },
                    ]}
                  />
                )}
              </Card>
              <BooksCard books={d.books} />
            </div>
          </div>
        </>
      )}
    </Gate>
  )
}
