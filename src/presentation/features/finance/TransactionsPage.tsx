import { Link, useLocation, useSearchParams } from 'react-router'
import { Plus, Search } from 'lucide-react'
import { cashSummary, filterTransactions, KIND_LABEL, TRANSACTION_STATUS_LABEL, TRANSACTION_STATUSES, type TransactionKind, type TransactionStatus } from '@/domain/finance'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { TableToolbar } from '../../ui/TableToolbar'
import { Input, Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { money } from '@/lib/format'
import { TransactionTable } from '../shared/TransactionTable'

type StatusFilter = TransactionStatus | 'all'
const FILTERS: StatusFilter[] = ['all', ...TRANSACTION_STATUSES]
const PENDING: StatusFilter[] = ['all', 'submitted', 'approved']

/** What the route fixes: a kind for Cash in and Cash out, the pending statuses for Approvals. */
function presetFor(pathname: string): { kind?: TransactionKind; pending?: boolean; blurb: string } {
  if (pathname.endsWith('/cash-in')) return { kind: 'cash_in', blurb: 'Money that came in: stay payments, Airbnb payouts, deposits and extras. Newest first.' }
  if (pathname.endsWith('/cash-out')) return { kind: 'cash_out', blurb: 'Money that went out: utilities, supplies, repairs, staff costs and refunds. Newest first.' }
  if (pathname.endsWith('/approvals')) return { pending: true, blurb: 'Entries waiting for a manager: submitted ones need approval, approved ones need posting.' }
  return { blurb: 'Every cash movement, newest first. Draft, submit, approve, post; reverse a posted entry instead of editing it.' }
}

export default function TransactionsPage() {
  const { finance, clock } = useServices()
  const data = useResource('finance.transactions', () => finance.transactions())
  const [params, setParams] = useSearchParams()
  const preset = presetFor(useLocation().pathname)
  const chips = preset.pending ? PENDING : FILTERS
  const status = (chips.find((f) => f === params.get('status')) ?? 'all') as StatusFilter
  const kind = preset.kind ?? ((params.get('kind') as TransactionKind | null) ?? '')
  const categoryId = params.get('category') ?? ''
  const accountId = params.get('account') ?? ''
  const query = params.get('q') ?? ''
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined

  function update(next: Partial<{ status: StatusFilter; kind: string; category: string; account: string; q: string; from: string; to: string }>) {
    const merged = { status, kind, category: categoryId, account: accountId, q: query, from: from ?? '', to: to ?? '', ...next }
    const search = new URLSearchParams()
    if (merged.status !== 'all') search.set('status', merged.status)
    for (const key of ['kind', 'category', 'account', 'q', 'from', 'to'] as const) if (merged[key]) search.set(key, merged[key])
    if (params.get('layout')) search.set('layout', params.get('layout') as string)
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const scope = preset.pending ? d.list.filter((t) => t.status === 'submitted' || t.status === 'approved') : preset.kind ? d.list.filter((t) => t.kind === preset.kind) : d.list
  const rows = filterTransactions(scope, { status, kind: (kind || 'all') as TransactionKind | 'all', categoryId: categoryId || undefined, accountId: accountId || undefined, query, from, to })
  const posted = cashSummary(rows, '0000-01-01', '9999-12-31')
  const pending = rows.filter((t) => t.status === 'submitted' || t.status === 'approved')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">{preset.blurb}</p>
        <Link to={`/finance/transactions/new${preset.kind ? `?kind=${preset.kind}` : ''}`} className={buttonStyles({ variant: 'accent' })}>
          <Plus aria-hidden className="size-4" /> New entry
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Cash in, posted" value={money(posted.cashIn)} hint="In the rows below" active={!preset.kind && kind === 'cash_in'} {...(preset.kind ? { to: '/finance/cash-in' } : { onClick: () => update({ kind: kind === 'cash_in' ? '' : 'cash_in' }) })} />
        <StatTile label="Cash out, posted" value={money(posted.cashOut)} hint="In the rows below" active={!preset.kind && kind === 'cash_out'} {...(preset.kind ? { to: '/finance/cash-out' } : { onClick: () => update({ kind: kind === 'cash_out' ? '' : 'cash_out' }) })} />
        <StatTile label="Net" value={money(posted.net)} hint={`${rows.length} entries match`} to="/?view=financial" />
        <StatTile label="Awaiting approval" value={pending.length} hint={money(pending.reduce((s, t) => s + t.amount, 0))} active={status === 'submitted'} onClick={() => update({ status: status === 'submitted' ? 'all' : 'submitted' })} />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={chips.map((f) => ({ value: f, label: f === 'all' ? 'All' : TRANSACTION_STATUS_LABEL[f], count: f === 'all' ? scope.length : scope.filter((t) => t.status === f).length }))}
          chip={status}
          onChip={(f) => update({ status: f })}
          summary={`${rows.length} of ${scope.length} entries`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Number or description" aria-label="Search transactions" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              {!preset.kind && <Select aria-label="Kind" value={kind} options={[{ value: '', label: 'In and out' }, { value: 'cash_in', label: KIND_LABEL.cash_in }, { value: 'cash_out', label: KIND_LABEL.cash_out }]} onChange={(e) => update({ kind: e.target.value })} />}
              <Select aria-label="Category" value={categoryId} options={[{ value: '', label: 'All categories' }, ...d.categories.map((c) => ({ value: c.id, label: c.name }))]} onChange={(e) => update({ category: e.target.value })} />
              <Select aria-label="Account" value={accountId} options={[{ value: '', label: 'All accounts' }, ...d.accounts.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => update({ account: e.target.value })} />
            </>
          }
          date={<DateRangeFilter today={clock.today()} label="Date" value={{ from, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={status !== 'all' || (!preset.kind && !!kind) || !!categoryId || !!accountId || !!query || !!from || !!to}
          onClear={() => setParams(params.get('layout') ? { layout: params.get('layout') as string } : {}, { replace: true })}
        />
        <TransactionTable
          label="Transactions"
          rows={rows}
          exportName="transactions"
          exportDate={clock.today()}
          empty={
            <EmptyState title="No entry matches" action={<Button variant="solid" size="sm" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>}>
              Nothing fits these filters.
            </EmptyState>
          }
        />
      </Card>
    </div>
  )
}
