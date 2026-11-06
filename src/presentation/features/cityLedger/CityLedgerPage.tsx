import { useState } from 'react'
import { Link } from 'react-router'
import { Plus } from 'lucide-react'
import { CITY_AGING_BUCKETS, CITY_AGING_LABEL, type CityLedgerAccountInput } from '@/domain/cityLedger'
import { money, percent } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { StatTile } from '../../ui/StatTile'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { AccountForm } from './AccountForm'

const EMPTY_ACCOUNT: CityLedgerAccountInput = { name: '', kind: 'company', contact: '', billingEmail: '', phone: '', address: '', npwp: '', creditLimit: 50_000_000, termsDays: 30, commissionPct: 0, active: true, villaIds: [] }

/** Companies and travel agents billed after the stay: what each owes, what is overdue and how much of its credit it uses. */
export default function CityLedgerPage() {
  const { cityLedger } = useServices()
  const { can } = useAccess()
  const data = useResource('cityLedger.overview', () => cityLedger.overview())
  const [adding, setAdding] = useState(false)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Owed in all" value={money(d.balance)} />
        {CITY_AGING_BUCKETS.map((k) => (
          <StatTile key={k} label={CITY_AGING_LABEL[k]} value={money(d.totals[k])} />
        ))}
      </div>
      <Card aria-labelledby="cl-title">
        <CardHeader id="cl-title" title="City ledger accounts" action={can('finance', 'create') && <Button size="sm" onClick={() => setAdding(true)}><Plus aria-hidden className="size-4" /> Account</Button>} />
        {adding && (
          <AccountForm
            id={null}
            initial={EMPTY_ACCOUNT}
            villas={d.villas}
            onDone={() => {
              setAdding(false)
              data.reload()
            }}
          />
        )}
        {d.rows.length === 0 ? (
          <EmptyState title="No accounts yet">Open one for each company or travel agent you bill after the stay.</EmptyState>
        ) : (
          <DataTable
            label="City ledger accounts"
            rows={d.rows}
            rowKey={(r) => r.id}
            columns={[
              { key: 'n', header: 'Account', cell: (r) => <Link to={`/city-ledger/${r.id}`} className="font-medium hover:underline">{r.code} {r.name}</Link> },
              { key: 'k', header: 'Kind', cell: (r) => <span className="text-muted">{r.kindLabel}{r.commissionPct ? `, ${r.commissionPct}%` : ''}{r.active ? '' : ', closed'}</span> },
              { key: 't', header: 'Terms', align: 'right', cell: (r) => `${r.termsDays} days` },
              { key: 'b', header: 'Balance', align: 'right', cell: (r) => money(r.balance) },
              { key: 'u', header: 'Not invoiced', align: 'right', cell: (r) => money(r.uninvoiced) },
              { key: 'o', header: 'Overdue', align: 'right', cell: (r) => (r.overdue > 0 ? <span className="font-medium text-danger">{money(r.overdue)}</span> : money(0)) },
              { key: 'c', header: 'Credit used', align: 'right', cell: (r) => <StatusPill tone={r.usedPct >= 1 ? 'danger' : r.usedPct >= 0.85 ? 'warning' : 'neutral'}>{percent(r.usedPct, { digits: 0 })} of {money(r.creditLimit)}</StatusPill> },
            ]}
            footer={['Total', '', '', money(d.balance), money(d.rows.reduce((s, r) => s + r.uninvoiced, 0)), money(d.overdue), '']}
          />
        )}
      </Card>
    </div>
  )
}
