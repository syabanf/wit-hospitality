import { Link } from 'react-router'
import { Plus } from 'lucide-react'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TRANSACTION_TONE } from '../shared/tones'

/** Adjusting journals finance writes by hand, each through the approval chain before it posts. */
export default function ManualJournalsPage() {
  const { accounting } = useServices()
  const { can } = useAccess()
  const data = useResource('accounting.manual', () => accounting.manualJournals())
  const newButton = can('finance', 'create') && (
    <Link to="/accounting/manual/new" className={buttonStyles({ variant: 'accent' })}>
      <Plus aria-hidden className="size-4" /> Manual journal
    </Link>
  )

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Accruals, reclassifications and payable settlements that no cash entry covers. Cash and bank accounts stay out: money moves through cash entries. Each journal signs like a cash-out of its total.</p>
        {newButton}
      </div>
      <Card className="p-0">
        <ListTable
          label="Manual journals"
          rows={data.data}
          rowKey={(m) => m.id}
          href={(m) => `/accounting/manual/${m.id}`}
          empty={<EmptyState title="No manual journals yet" action={newButton || undefined}>Write one when an accrual or a correction has no cash entry behind it.</EmptyState>}
          columns={[
            { key: 'number', header: 'Journal', cell: (m) => <span className="font-medium tabular">{m.number}</span>, value: (m) => m.number },
            { key: 'date', header: 'Date', cell: (m) => m.date, value: (m) => m.date },
            { key: 'memo', header: 'Memo', cell: (m) => <span className="line-clamp-1">{m.memo}</span>, value: (m) => m.memo },
            { key: 'villa', header: 'Villa', cell: (m) => m.villaName, value: (m) => m.villaName, hide: 'lg' },
            { key: 'status', header: 'Status', cell: (m) => <StatusPill tone={TRANSACTION_TONE[m.status]}>{TRANSACTION_STATUS_LABEL[m.status]}</StatusPill>, value: (m) => TRANSACTION_STATUS_LABEL[m.status] },
            { key: 'amount', header: 'Amount', align: 'right', cell: (m) => <span className="font-semibold tabular">{money(m.amount)}</span>, value: (m) => m.amount },
          ]}
          card={(m) => (
            <div className="min-w-0">
              <p className="flex justify-between gap-3 font-medium">
                <span className="truncate">{m.memo}</span>
                <span className="shrink-0 tabular">{money(m.amount)}</span>
              </p>
              <p className="truncate text-xs text-muted">
                {m.number} · {m.date} · {TRANSACTION_STATUS_LABEL[m.status]}
              </p>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
