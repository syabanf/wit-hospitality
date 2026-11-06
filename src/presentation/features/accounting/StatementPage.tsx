import { Link, useLocation } from 'react-router'
import { FileBarChart } from 'lucide-react'
import type { StatementLine } from '@/domain/journal'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useFilters } from './filters'
import { Amount, VillaSelect } from './shared'

type Statement = 'trial-balance' | 'income-statement' | 'balance-sheet'

/** One section of a statement: its accounts, each opening its ledger, and a total. */
function Section({ title, lines, totalLabel, total, extra }: { title: string; lines: readonly StatementLine[]; totalLabel: string; total: number; extra?: { label: string; amount: number } }) {
  return (
    <Card aria-label={title}>
      <CardHeader title={title} />
      <ul className="divide-y divide-line text-sm">
        {lines.map((l) => (
          <li key={l.account.id}>
            <Link to={`/accounting/ledger?account=${l.account.id}`} className="flex gap-3 py-2 hover:underline">
              <span className="w-12 shrink-0 text-xs text-muted tabular">{l.account.code}</span>
              <span className="min-w-0 flex-1 truncate">{l.account.name}</span>
              <span className="tabular">{money(l.amount)}</span>
            </Link>
          </li>
        ))}
        {extra && (
          <li className="flex gap-3 py-2">
            <span className="w-12 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{extra.label}</span>
            <span className="tabular">{money(extra.amount)}</span>
          </li>
        )}
        <li className="flex gap-3 border-t border-line-strong pt-2.5 font-semibold">
          <span className="flex-1">{totalLabel}</span>
          <span className="tabular">{money(total)}</span>
        </li>
      </ul>
    </Card>
  )
}

/** Trial balance, income statement and balance sheet from the journals, by range and villa. */
export default function StatementPage() {
  const statement = useLocation().pathname.split('/').pop() as Statement
  const { accounting, clock } = useServices()
  const { values: f, update } = useFilters(['from', 'to', 'villa'] as const)
  const today = clock.today()
  const to = f.to || today
  const range = statement === 'income-statement'
  const data = useResource(`accounting.${statement}:${f.from}:${to}:${f.villa}`, async () => {
    const villaId = f.villa || undefined
    if (statement === 'trial-balance') return { kind: statement, ...(await accounting.trialBalance({ to, villaId })) } as const
    if (statement === 'income-statement') return { kind: statement, ...(await accounting.incomeStatement({ from: f.from || `${today.slice(0, 4)}-01-01`, to, villaId })) } as const
    return { kind: 'balance-sheet', ...(await accounting.balanceSheet({ asOf: to, villaId })) } as const
  })
  const report = new URLSearchParams({ ...(range && f.from ? { from: f.from } : {}), to, ...(f.villa ? { villa: f.villa } : {}) })

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={10} />
  const d = data.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {range ? (
            <DateRangeFilter tone="card" today={today} value={{ from: f.from || `${today.slice(0, 4)}-01-01`, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />
          ) : (
            <Input tone="card" type="date" aria-label="As of" className="h-10 w-44 px-3" value={to} max={today} onChange={(e) => update({ to: e.target.value })} />
          )}
          <VillaSelect villas={d.villas} value={f.villa} onChange={(villa) => update({ villa })} />
        </div>
        <Link to={`/reports/${statement}?${report.toString()}`} className={buttonStyles({ variant: 'card' })}>
          <FileBarChart aria-hidden className="size-4" /> Open as report for CSV
        </Link>
      </div>
      {d.kind === 'trial-balance' && (
        <Card aria-labelledby="tb-title">
          <CardHeader id="tb-title" title={`Trial balance on ${to}`} action={<StatusPill tone={d.debit === d.credit ? 'success' : 'danger'}>{d.debit === d.credit ? 'Debits equal credits' : `Out by ${money(Math.abs(d.debit - d.credit))}`}</StatusPill>} />
          <DataTable
            label="Trial balance"
            rows={d.rows}
            rowKey={(r) => r.account.id}
            columns={[
              { key: 'account', header: 'Account', cell: (r) => <Link to={`/accounting/ledger?account=${r.account.id}`} className="hover:underline"><span className="mr-2 text-xs text-muted tabular">{r.account.code}</span>{r.account.name}</Link> },
              { key: 'debit', header: 'Debit', align: 'right', cell: (r) => <Amount value={r.debit} /> },
              { key: 'credit', header: 'Credit', align: 'right', cell: (r) => <Amount value={r.credit} /> },
            ]}
            footer={['Total', money(d.debit), money(d.credit)]}
          />
        </Card>
      )}
      {d.kind === 'income-statement' && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Revenue" lines={d.revenue} totalLabel="Total revenue" total={d.totalRevenue} />
            <Section title="Expenses" lines={d.expenses} totalLabel="Total expenses" total={d.totalExpenses} />
          </div>
          <Card className={cn('flex items-center justify-between', d.net < 0 && 'text-danger')}>
            <span className="font-semibold">Net profit</span>
            <span className="text-xl font-semibold tabular">{money(d.net)}</span>
          </Card>
        </>
      )}
      {d.kind === 'balance-sheet' && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Section title="Assets" lines={d.assets} totalLabel="Total assets" total={d.totalAssets} />
            <div className="space-y-4">
              <Section title="Liabilities" lines={d.liabilities} totalLabel="Total liabilities" total={d.totalLiabilities} />
              <Section title="Equity" lines={d.equity} totalLabel="Total equity" total={d.totalEquity} extra={{ amount: d.yearEarnings, label: 'Profit this year' }} />
            </div>
          </div>
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <span className="font-semibold">Liabilities and equity</span>
            <span className="flex items-center gap-3">
              <StatusPill tone={d.balanced ? 'success' : 'danger'}>{d.balanced ? 'Balances with assets' : 'Does not balance'}</StatusPill>
              <span className="text-xl font-semibold tabular">{money(d.totalLiabilities + d.totalEquity)}</span>
            </span>
          </Card>
        </>
      )}
    </div>
  )
}
