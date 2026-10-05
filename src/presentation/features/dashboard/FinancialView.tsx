import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import type { DashboardFilter } from '@/application/views'
import { change, PERIOD_LABEL } from '@/domain/dashboard'
import { cn } from '@/lib/cn'
import { addDays, shortDay } from '@/lib/dates'
import { money, moneyCompact, percent } from '@/lib/format'
import { seriesColor } from '../../charts/colors'
import { Donut } from '../../charts/Donut'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import type { Layout } from '../../hooks/useLayout'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TransactionRows } from '../shared/TransactionRows'
import { TransactionTable } from '../shared/TransactionTable'
import { AccountTable } from '../finance/AccountTable'
import { filterKey } from './filters'

/** Cash in against cash out, spending by category, account balances and the newest entries. */
export function FinancialView({ filter, layout }: { filter: DashboardFilter; layout: Layout }) {
  const { dashboard } = useServices()
  const data = useResource(`dashboard.financial:${filterKey(filter)}`, () => dashboard.financial(filter))
  const [active, setActive] = useState<string | null>(null)

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
  const expenseTotal = d.expenses.reduce((s, x) => s + x.value, 0)

  const tiles = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label={`Cash in, ${periodLabel}`} value={money(d.summary.cashIn)} change={change(d.summary.cashIn, d.previous.cashIn)} to="/finance/cash-in" />
      <StatTile label={`Cash out, ${periodLabel}`} value={money(d.summary.cashOut)} change={change(d.summary.cashOut, d.previous.cashOut)} goodWhenUp={false} to="/finance/cash-out" />
      <StatTile label="Net cash" value={money(d.summary.net)} change={change(d.summary.net, d.previous.net)} hint={`Balances total ${moneyCompact(d.totalBalance)}`} to="/finance" />
      <StatTile label="Awaiting approval" value={d.pending.count} hint={money(d.pending.amount)} to="/finance/approvals" />
    </div>
  )

  if (layout === 'table') {
    return (
      <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
        {tiles}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card aria-labelledby="fin-t-flow">
            <CardHeader id="fin-t-flow" title={`Cash flow per ${filter.period === '7d' ? 'day' : 'week'}`} />
            <DataTable
              label="Cash flow"
              rows={d.weeks}
              rowKey={(w) => w.key}
              columns={[
                { key: 'p', header: 'Period', cell: (w) => w.label },
                { key: 'in', header: 'Cash in', align: 'right', cell: (w) => money(w.cashIn) },
                { key: 'out', header: 'Cash out', align: 'right', cell: (w) => money(w.cashOut) },
                { key: 'net', header: 'Net', align: 'right', cell: (w) => money(w.net) },
              ]}
              footer={['Total', money(d.summary.cashIn), money(d.summary.cashOut), money(d.summary.net)]}
            />
          </Card>
          <Card aria-labelledby="fin-t-expenses">
            <CardHeader id="fin-t-expenses" title="Spending by category" />
            <DataTable
              label="Spending by category"
              rows={d.expenses}
              rowKey={(s) => s.id}
              columns={[
                { key: 'c', header: 'Category', cell: (s) => <Link to={s.id === 'other' ? '/finance/transactions?kind=cash_out' : `/finance/transactions?category=${s.id}`} className="hover:underline">{s.label}</Link> },
                { key: 'a', header: 'Amount', align: 'right', cell: (s) => money(s.value) },
                { key: 'sh', header: 'Share', align: 'right', cell: (s) => percent(expenseTotal ? s.value / expenseTotal : 0, { digits: 0 }) },
              ]}
              footer={['Total', money(expenseTotal), '100%']}
            />
          </Card>
        </div>
        <Card className="p-0" aria-labelledby="fin-t-accounts">
          <div className="p-5 pb-0">
            <CardHeader id="fin-t-accounts" title="Balances" />
          </div>
          <AccountTable label="Balances" rows={d.accounts} />
        </Card>
        <Card className="p-0" aria-labelledby="fin-t-recent">
          <div className="p-5 pb-0">
            <CardHeader id="fin-t-recent" title="Latest entries" action={<Link to="/finance/transactions" className="text-sm text-accent-text hover:underline">All transactions</Link>} />
          </div>
          <TransactionTable label="Latest entries" rows={d.recent} />
        </Card>
      </div>
    )
  }

  return (
    <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
      {tiles}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card className="md:col-span-2" aria-labelledby="fin-flow">
          <CardHeader
            id="fin-flow"
            title="Cash flow"
            action={
              <ul className="flex gap-3 text-xs text-muted">
                <li className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: seriesColor(2) }} /> Cash in
                </li>
                <li className="flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: seriesColor(1) }} /> Cash out
                </li>
              </ul>
            }
          />
          <GroupedColumns
            label={`Cash in and out per ${filter.period === '7d' ? 'day' : 'week'}`}
            className="h-64"
            labels={d.weeks.map((w) => w.label)}
            series={[
              { id: 'in', label: 'Cash in', color: seriesColor(2) },
              { id: 'out', label: 'Cash out', color: seriesColor(1) },
            ]}
            values={[d.weeks.map((w) => w.cashIn), d.weeks.map((w) => w.cashOut)]}
            format={moneyCompact}
          />
        </Card>

        <Card aria-labelledby="fin-expenses">
          <CardHeader id="fin-expenses" title="Spending by category" />
          {d.expenses.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No posted spending in this scope.</p>
          ) : (
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start xl:flex-col xl:items-center">
              <Donut
                label="Spending by category"
                size={180}
                slices={d.expenses.map((s) => ({ id: s.id, label: s.label, value: s.value, color: seriesColor(s.slot) }))}
                active={active}
                onActive={setActive}
                chip={(s) => `${s.label}: ${moneyCompact(s.value)} (${percent(s.value / expenseTotal, { digits: 0 })})`}
              >
                <p className="text-[22px] leading-none font-medium tracking-tight tabular">{moneyCompact(expenseTotal)}</p>
                <p className="mt-1 text-xs text-muted">spent</p>
              </Donut>
              <ul className="w-full space-y-1">
                {d.expenses.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={s.id === 'other' ? '/finance/transactions?kind=cash_out' : `/finance/transactions?category=${s.id}`}
                      onPointerEnter={() => setActive(s.id)}
                      onPointerLeave={() => setActive(null)}
                      onFocus={() => setActive(s.id)}
                      onBlur={() => setActive(null)}
                      className={cn('flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm transition-colors hover:bg-raised', active === s.id && 'bg-raised')}
                    >
                      <span aria-hidden className="size-2.5 rounded-full" style={{ background: seriesColor(s.slot) }} />
                      <span className="flex-1 truncate">{s.label}</span>
                      <span className="font-medium tabular">{moneyCompact(s.value)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card aria-labelledby="fin-accounts">
          <CardHeader id="fin-accounts" title="Balances" />
          <ul className="divide-y divide-line">
            {d.accounts.map((row) => (
              <li key={row.account.id}>
                <Link to={`/finance/accounts/${row.account.id}`} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{row.account.name}</span>
                    <span className="block text-xs text-muted">{row.location?.name ?? 'All locations'}</span>
                  </span>
                  <span className="font-semibold tabular">{money(row.balance)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="md:col-span-2" aria-labelledby="fin-recent">
          <CardHeader
            id="fin-recent"
            title="Latest entries"
            action={
              <Link to="/finance/transactions" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                All transactions <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          />
          <TransactionRows rows={d.recent} empty="No posted entries in this scope." />
        </Card>
      </div>
    </div>
  )
}
