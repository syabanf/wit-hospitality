import type { TransactionView } from '@/application/views'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { StatusPill } from '../../ui/Badge'
import { ListTable } from '../../ui/ListTable'
import { EmptyState } from '../../ui/States'
import { TRANSACTION_TONE } from './tones'

interface TransactionTableProps {
  rows: readonly TransactionView[]
  label: string
  empty?: React.ReactNode
  exportName?: string
  exportDate?: string
}

const amount = (t: TransactionView) => (
  <span className={cn('font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>
    {t.kind === 'cash_out' ? '-' : '+'}
    {money(t.amount)}
  </span>
)

/** The one transaction table; rows open the entry. */
export function TransactionTable({ rows, label, empty, exportName, exportDate }: TransactionTableProps) {
  return (
    <ListTable
      label={label}
      rows={rows}
      rowKey={(t) => t.id}
      href={(t) => `/finance/transactions/${t.id}`}
      defaultSort={{ key: 'date', dir: 'desc' }}
      exportName={exportName}
      exportDate={exportDate}
      empty={empty ?? <EmptyState title="No entries" />}
      columns={[
        { key: 'desc', header: 'Description', cell: (t) => <span className="line-clamp-1">{t.description}</span>, value: (t) => t.description },
        { key: 'no', header: 'Number', cell: (t) => <span className="font-mono text-xs text-muted">{t.number}</span>, value: (t) => t.number, hide: 'xl' },
        { key: 'date', header: 'Date', cell: (t) => shortDay(t.date), value: (t) => t.date },
        { key: 'cat', header: 'Category', cell: (t) => t.categoryName, value: (t) => t.categoryName, hide: 'lg' },
        { key: 'acc', header: 'Account', cell: (t) => t.accountName, value: (t) => t.accountName, hide: 'xl' },
        { key: 'map', header: 'Mapped to', cell: (t) => [t.location.name, t.villa?.name, t.unit?.code].filter(Boolean).join(' · '), value: (t) => [t.location.name, t.villa?.name, t.unit?.code].filter(Boolean).join(' · '), hide: 'lg' },
        { key: 'status', header: 'Status', cell: (t) => <StatusPill tone={TRANSACTION_TONE[t.status]}>{TRANSACTION_STATUS_LABEL[t.status]}</StatusPill>, value: (t) => TRANSACTION_STATUS_LABEL[t.status] },
        { key: 'amount', header: 'Net', align: 'right', cell: amount, value: (t) => (t.kind === 'cash_out' ? -t.amount : t.amount), total: (sum) => `${sum < 0 ? '-' : '+'}${money(Math.abs(sum))}` },
      ]}
      card={(t) => (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{t.description}</p>
            <p className="text-xs text-muted">
              {shortDay(t.date)} · {t.categoryName} · {t.accountName}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-sm">{amount(t)}</span>
            <StatusPill tone={TRANSACTION_TONE[t.status]}>{TRANSACTION_STATUS_LABEL[t.status]}</StatusPill>
          </div>
        </div>
      )}
    />
  )
}
