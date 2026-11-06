import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { periodLabel } from '@/domain/payroll'
import { cn } from '@/lib/cn'
import { shortMonth } from '@/lib/dates'
import { money, moneyCompact, percent } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { ownerKey, parseOwner } from '../owner/filters'
import { BooksCard, OwnerToolbar } from '../owner/parts'

const pct = (v: number) => percent(v, { digits: 0 })

/** The owner's villas at a glance: occupancy, ADR, RevPAR and room revenue against the comparison, the trend and the nights ahead. */
export default function PortalHomePage() {
  const { portal, clock } = useServices()
  const [params] = useSearchParams()
  const state = parseOwner(params, clock.today())
  const data = useResource(`portal.performance:${ownerKey(state.filter)}`, () => portal.performance(state.filter))
  const [month, setMonth] = useState<string | null>(null)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const k = d.kpis
  const picked = d.trend.find((m) => m.month === month)

  return (
    <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
      <OwnerToolbar state={state} scope={false} />
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Occupancy" value={pct(k.occupancy.value)} change={k.occupancy.change} hint={`${k.sold} of ${k.available} nights sold`} />
        <StatTile label="ADR" value={money(k.adr.value)} change={k.adr.change} hint="Room revenue per night sold" />
        <StatTile label="RevPAR" value={money(k.revpar.value)} change={k.revpar.change} hint="Room revenue per night available" />
        <StatTile label="Room revenue" value={money(k.revenue.value)} change={k.revenue.change} hint={`was ${money(k.revenue.previous)}`} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card aria-labelledby="pv-villas">
          <CardHeader id="pv-villas" title="Your villas" />
          <DataTable
            label="Your villas"
            rows={d.villas}
            rowKey={(v) => v.id}
            columns={[
              { key: 'v', header: 'Villa', cell: (v) => <span className="font-medium">{v.name}</span> },
              { key: 'o', header: 'Occupancy', align: 'right', cell: (v) => pct(v.kpis.occupancy.value) },
              { key: 'a', header: 'ADR', align: 'right', cell: (v) => money(v.kpis.adr.value) },
              { key: 'r', header: 'RevPAR', align: 'right', cell: (v) => money(v.kpis.revpar.value) },
              { key: 'm', header: 'Revenue', align: 'right', cell: (v) => money(v.kpis.revenue.value) },
            ]}
          />
        </Card>
        <Card aria-labelledby="pv-trend">
          <CardHeader id="pv-trend" title="Room revenue, last six months" />
          <ColumnChart label="Room revenue per month" className="h-48" data={d.trend.map((m) => ({ key: m.month, label: shortMonth(`${m.month}-01`), value: m.revenue }))} selected={month} onSelect={(key) => setMonth(key === month ? null : key)} format={money} tick={moneyCompact} />
          <p className="mt-3 text-sm text-muted">{picked ? `${periodLabel(picked.month)}: ${money(picked.revenue)}, ${pct(picked.occupancy)} occupancy, ADR ${money(picked.adr)}` : 'Pick a month for its occupancy and ADR.'}</p>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
        <BooksCard books={d.books} />
        <Card aria-labelledby="pv-income">
          <CardHeader id="pv-income" title="Your income" />
          <p className="text-xs text-muted">Net payable this year, approved statements</p>
          <p className="mt-1 text-2xl font-medium tracking-tight tabular">{money(d.netYear)}</p>
          {d.latest ? (
            <Link to={`/portal/statements/${d.latest.id}`} className="mt-3 block text-sm font-medium hover:underline">
              Latest: {periodLabel(d.latest.month)}, {d.latest.villaName}, {money(d.latest.payable)} · {d.latest.label.toLowerCase()}
            </Link>
          ) : (
            <p className="mt-3 text-sm text-muted">Your first statement shows here once the operator approves it.</p>
          )}
        </Card>
      </div>
    </div>
  )
}
