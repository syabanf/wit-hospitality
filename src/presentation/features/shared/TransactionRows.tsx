import { Link } from 'react-router'
import type { TransactionView } from '@/application/views'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { StatusPill } from '../../ui/Badge'
import { TRANSACTION_TONE } from './tones'

/** Date, description, category and account, status from `sm`, the signed amount; each row opens the entry. */
export function TransactionRows({ rows, empty }: { rows: readonly TransactionView[]; empty: string }) {
  if (rows.length === 0) return <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {rows.map((t) => (
        <li key={t.id}>
          <Link to={`/finance/transactions/${t.id}`} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <span className="w-14 shrink-0 text-xs text-muted">{shortDay(t.date)}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.description}</span>
              <span className="block truncate text-xs text-muted">
                {t.categoryName} · {t.accountName}
              </span>
            </span>
            <StatusPill tone={TRANSACTION_TONE[t.status]} className="hidden sm:inline-flex">
              {TRANSACTION_STATUS_LABEL[t.status]}
            </StatusPill>
            <span className={cn('shrink-0 font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>
              {t.kind === 'cash_out' ? '-' : '+'}
              {money(t.amount)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
