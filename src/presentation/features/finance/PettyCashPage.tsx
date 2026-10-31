import { Link } from 'react-router'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { PettyFacts } from './PettyCash'

/** Every villa's petty cash: what is left against the float, who holds it, and a top-up when it runs low. */
export default function PettyCashPage() {
  const { finance } = useServices()
  const data = useResource('finance.pettyCash', () => finance.pettyCash())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Petty cash on hand" value={money(d.total)} hint={`Against ${money(d.float)} of floats`} />
        <StatTile label="Boxes running low" value={d.low} hint="Under a quarter of the float" />
        <StatTile label="Villas with petty cash" value={d.rows.length} />
      </div>
      {d.rows.length === 0 ? (
        <EmptyState title="No petty cash yet">Open one per villa from Master data, Cash accounts, with the kind Villa petty cash.</EmptyState>
      ) : (
        <div className="stagger grid grid-cols-1 gap-4 lg:grid-cols-2">
          {d.rows.map((r) => (
            <Card key={r.account.id} aria-labelledby={`pc-${r.account.id}`}>
              <CardHeader
                id={`pc-${r.account.id}`}
                title={r.villa?.name ?? r.account.name}
                action={
                  <Link to={`/finance/accounts/${r.account.id}`} className="text-xs font-medium text-accent-text hover:underline">
                    Entries and counts
                  </Link>
                }
              />
              <PettyFacts row={r} compact />
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
