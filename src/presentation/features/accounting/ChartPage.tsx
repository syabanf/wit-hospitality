import { Link } from 'react-router'
import { GL_TYPE_LABEL, GL_TYPES } from '@/domain/journal'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'

/** The chart of accounts with today's balances; each account opens its general ledger. */
export default function ChartPage() {
  const { accounting } = useServices()
  const data = useResource('accounting.chart', () => Promise.all([accounting.chart(), accounting.balanceSheet({}), accounting.incomeStatement({})]))

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={10} />
  const [chart, bs, is] = data.data

  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-2 gap-3 min-[1360px]:grid-cols-4">
        <StatTile label="Assets" value={money(bs.totalAssets)} hint="Cash, receivables and loans" to="/accounting/balance-sheet" />
        <StatTile label="Liabilities" value={money(bs.totalLiabilities)} hint="Deposits, payables, BPJS and tax" to="/accounting/balance-sheet" />
        <StatTile label="Equity" value={money(bs.totalEquity)} hint={bs.balanced ? 'Balance sheet balances' : 'Balance sheet is out'} to="/accounting/balance-sheet" />
        <StatTile label="Net profit to date" value={money(is.net)} hint={`${money(is.totalRevenue)} revenue`} to="/accounting/income-statement" />
      </div>
      <p className="max-w-2xl text-sm text-muted">Staff keep recording cash entries. Every posted entry writes a balanced journal entry against these accounts: the cash account it moved through and the account its category or its transaction code books to. Guest revenue follows the transaction codes; the Categories page maps the rest.</p>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {GL_TYPES.map((type) => (
          <Card key={type} aria-labelledby={`gl-${type}`}>
            <CardHeader id={`gl-${type}`} title={GL_TYPE_LABEL[type]} action={<span className="text-xs text-muted">Normal side {type === 'asset' || type === 'expense' ? 'debit' : 'credit'}</span>} />
            <ul className="divide-y divide-line">
              {chart
                .filter((a) => a.type === type)
                .map((a) => (
                  <li key={a.id}>
                    <Link to={`/accounting/ledger?account=${a.id}`} className="flex items-center gap-3 py-2.5 hover:underline">
                      <span className="w-12 shrink-0 text-xs text-muted tabular">{a.code}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{a.name}</span>
                        <span className="block truncate text-xs text-muted">{a.cashAccount ? `Mirrors ${a.cashAccount}` : a.codes.length ? `Codes ${a.codes.join(', ')}` : a.categories.length ? a.categories.join(', ') : `${a.entries} entries`}</span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular">{money(a.balance)}</span>
                    </Link>
                  </li>
                ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  )
}
