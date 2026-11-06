import { Link } from 'react-router'
import { periodLabel } from '@/domain/payroll'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'

const TONE = { none: 'accent', waiting: 'warning', paid: 'success', rejected: 'danger' } as const
/** A shortfall waiting on a later month or the owner shows as pending. */
const tone = (r: { payable: number; payoutState: keyof typeof TONE }) => (r.payable < 0 && r.payoutState === 'none' ? 'warning' : TONE[r.payoutState])

/** Statements the operator approved, or their payouts: `payouts` shows the money side. */
export function PortalStatementList({ payouts = false }: { payouts?: boolean }) {
  const { portal } = useServices()
  const data = useResource('portal.statements', () => portal.statements())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const rows = data.data
  if (!rows.length) return <EmptyState title="Nothing yet">Statements show here once the operator closes and approves a month.</EmptyState>
  const link = (r: (typeof rows)[number]) => (
    <Link to={`/portal/statements/${r.id}`} className="font-medium hover:underline">
      {periodLabel(r.month)}
    </Link>
  )
  return (
    <Card>
      <DataTable
        label={payouts ? 'Payouts' : 'Statements'}
        rows={rows}
        rowKey={(r) => r.id}
        columns={
          payouts
            ? [
                { key: 'm', header: 'Month', cell: link },
                { key: 'v', header: 'Villa', cell: (r) => r.villaName },
                { key: 'd', header: 'Due', cell: (r) => shortDay(r.dueOn) },
                { key: 'p', header: 'Paid on', cell: (r) => (r.payoutState === 'paid' && r.payout ? shortDay(r.payout.date) : '') },
                { key: 'a', header: 'Amount', align: 'right', cell: (r) => money(r.payable) },
                { key: 's', header: 'Status', cell: (r) => <StatusPill tone={tone(r)}>{r.label}</StatusPill> },
              ]
            : [
                { key: 'm', header: 'Month', cell: link },
                { key: 'v', header: 'Villa', cell: (r) => r.villaName },
                { key: 'r', header: 'Revenue', align: 'right', cell: (r) => money(r.figures.totalRevenue) },
                { key: 'f', header: 'Fee', align: 'right', cell: (r) => money(r.figures.managementFee) },
                { key: 'n', header: 'Net payable', align: 'right', cell: (r) => money(r.figures.netPayable) },
                { key: 'b', header: 'Brought forward', align: 'right', cell: (r) => (r.broughtForward ? `(${money(r.broughtForward)})` : '') },
                { key: 'p', header: 'After carry forward', align: 'right', cell: (r) => money(r.payable) },
                { key: 's', header: 'Payout', cell: (r) => <StatusPill tone={tone(r)}>{r.label}</StatusPill> },
              ]
        }
      />
    </Card>
  )
}

export default function PortalStatementsPage() {
  return <PortalStatementList />
}
