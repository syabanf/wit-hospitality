import { Link } from 'react-router'
import { GL_TYPE_LABEL } from '@/domain/journal'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useFilters } from './filters'
import { Amount, VillaSelect } from './shared'

/** The general ledger of one account: opening balance, each line with its running balance, closing balance. */
export default function LedgerPage() {
  const { accounting, clock } = useServices()
  const { values: f, update } = useFilters(['account', 'from', 'to', 'villa'] as const)
  const data = useResource(`accounting.ledger:${f.account}:${f.from}:${f.to}:${f.villa}`, () => accounting.ledger(f.account || undefined, { from: f.from || undefined, to: f.to || undefined, villaId: f.villa || undefined }))

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const debits = d.lines.reduce((s, l) => s + l.debit, 0)
  const credits = d.lines.reduce((s, l) => s + l.credit, 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Account" tone="card" value={d.account.id} options={d.chart.map((a) => ({ value: a.id, label: `${a.code} ${a.name}` }))} onChange={(e) => update({ account: e.target.value })} />
        <VillaSelect villas={d.villas} value={f.villa} onChange={(villa) => update({ villa })} />
        <DateRangeFilter tone="card" today={clock.today()} value={{ from: f.from || undefined, to: f.to || undefined }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />
      </div>
      <div className="stagger grid grid-cols-2 gap-3 min-[1360px]:grid-cols-4">
        <StatTile label="Opening" value={money(d.opening)} hint={f.from ? `Before ${f.from}` : 'From the first entry'} />
        <StatTile label="Debits" value={money(debits)} hint={`${d.lines.filter((l) => l.debit).length} lines`} />
        <StatTile label="Credits" value={money(credits)} hint={`${d.lines.filter((l) => l.credit).length} lines`} />
        <StatTile label="Closing" value={money(d.closing)} hint={`${GL_TYPE_LABEL[d.account.type]}, normal side ${d.account.normal}`} />
      </div>
      <Card aria-labelledby="gl-lines">
        <CardHeader id="gl-lines" title={`${d.account.code} ${d.account.name}`} />
        {d.lines.length === 0 ? (
          <EmptyState title="No lines in this range">Pick another range or account.</EmptyState>
        ) : (
          <DataTable
            label="Ledger lines"
            rows={d.lines.map((l, i) => ({ ...l, key: `${l.entry.id}-${i}` }))}
            rowKey={(l) => l.key}
            columns={[
              { key: 'date', header: 'Date', cell: (l) => <span className="whitespace-nowrap">{l.entry.date}</span> },
              { key: 'entry', header: 'Entry', cell: (l) => <Link to={`/accounting/journals/${l.entry.id}`} className="font-medium tabular hover:underline">{l.entry.number}</Link> },
              { key: 'memo', header: 'Memo', cell: (l) => <span className="line-clamp-1">{l.entry.memo}</span> },
              { key: 'debit', header: 'Debit', align: 'right', cell: (l) => <Amount value={l.debit} /> },
              { key: 'credit', header: 'Credit', align: 'right', cell: (l) => <Amount value={l.credit} /> },
              { key: 'balance', header: 'Balance', align: 'right', cell: (l) => <span className="font-semibold tabular">{money(l.balance)}</span> },
            ]}
            footer={['', '', 'Closing', money(debits), money(credits), money(d.closing)]}
          />
        )}
      </Card>
    </div>
  )
}
