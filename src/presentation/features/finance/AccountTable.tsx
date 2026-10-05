import type { CashAccount, CashSummary } from '@/domain/finance'
import type { Location } from '@/domain/property'
import { money } from '@/lib/format'
import { Tag } from '../../ui/Badge'
import { ListTable, type Column } from '../../ui/ListTable'
import { EmptyState } from '../../ui/States'

export interface AccountTableRow {
  account: CashAccount
  balance: number
  location: Location | null
  in30?: CashSummary
}

/** Accounts with their balance; rows open the ledger. The 30-day columns show when the rows carry them. */
export function AccountTable({ rows, label }: { rows: readonly AccountTableRow[]; label: string }) {
  const flow: Column<AccountTableRow>[] = rows.some((r) => r.in30)
    ? [
        { key: 'in', header: 'In, 30 days', align: 'right', cell: (r) => <span className="tabular">{money(r.in30?.cashIn ?? 0)}</span>, value: (r) => r.in30?.cashIn ?? 0, hide: 'lg' },
        { key: 'out', header: 'Out, 30 days', align: 'right', cell: (r) => <span className="tabular">{money(r.in30?.cashOut ?? 0)}</span>, value: (r) => r.in30?.cashOut ?? 0, hide: 'lg' },
      ]
    : []
  return (
    <ListTable
      label={label}
      rows={rows}
      rowKey={(r) => r.account.id}
      href={(r) => `/finance/accounts/${r.account.id}`}
      empty={<EmptyState title="No accounts" />}
      columns={[
        { key: 'name', header: 'Account', cell: (r) => r.account.name, value: (r) => r.account.name },
        { key: 'kind', header: 'Kind', cell: (r) => <Tag tone={r.account.kind === 'bank' ? 'info' : 'neutral'}>{r.account.kind === 'bank' ? 'Bank' : 'Cashbox'}</Tag>, value: (r) => r.account.kind },
        { key: 'loc', header: 'Location', cell: (r) => r.location?.name ?? 'All locations', value: (r) => r.location?.name ?? '' },
        { key: 'open', header: 'Opening', align: 'right', cell: (r) => <span className="tabular">{money(r.account.openingBalance)}</span>, value: (r) => r.account.openingBalance, hide: 'xl' },
        ...flow,
        { key: 'bal', header: 'Balance', align: 'right', cell: (r) => <span className="font-semibold tabular">{money(r.balance)}</span>, value: (r) => r.balance },
      ]}
      card={(r) => (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{r.account.name}</p>
            <p className="text-xs text-muted">{r.location?.name ?? 'All locations'}</p>
          </div>
          <span className="text-sm font-semibold tabular">{money(r.balance)}</span>
        </div>
      )}
    />
  )
}
