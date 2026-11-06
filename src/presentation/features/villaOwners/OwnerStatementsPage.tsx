import { Link, useSearchParams } from 'react-router'
import { periodLabel } from '@/domain/payroll'
import { addMonths, startOfMonth } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, type Tone } from '../../ui/Badge'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { OwnersTabs } from './OwnersTabs'

const TONE: Record<string, Tone> = { Open: 'info', 'Awaiting approval': 'warning', 'To pay': 'accent', 'Being approved': 'warning', Paid: 'success', 'Payout rejected': 'danger' }

/** One month across every contract: the figures so far, or the closed statement and where its payout stands. */
export default function OwnerStatementsPage() {
  const { owners, clock } = useServices()
  const [params, setParams] = useSearchParams()
  const today = clock.today()
  const months = Array.from({ length: 12 }, (_, i) => addMonths(startOfMonth(today), -i - 1).slice(0, 7))
  const month = months.find((m) => m === params.get('month')) ?? months[0] ?? today.slice(0, 7)
  const data = useResource(`owners.statements:${month}`, () => owners.statements(month))

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const label = (r: (typeof d.rows)[number]) => r.statement?.label ?? 'Open'

  return (
    <div className="space-y-4">
      <OwnersTabs />
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Month" tone="card" value={month} options={months.map((m) => ({ value: m, label: periodLabel(m) }))} onChange={(e) => setParams({ month: e.target.value }, { replace: true })} />
        <p className="text-sm text-muted">Finance closes each statement once the month has ended, the Owner approves it, then finance pays it from the bank.</p>
      </div>
      <Card aria-labelledby="st-title">
        <CardHeader id="st-title" title={`Statements for ${periodLabel(month)}`} />
        {d.rows.length === 0 ? (
          <EmptyState title="No contract runs in this month" />
        ) : (
          <DataTable
            label="Owner statements"
            rows={d.rows}
            rowKey={(r) => r.contract.id}
            columns={[
              { key: 'v', header: 'Villa', cell: (r) => <Link to={`/villa-owners/statements/${r.contract.id}/${month}`} className="font-medium hover:underline">{r.contract.villa.name}</Link> },
              { key: 'o', header: 'Owner', cell: (r) => r.contract.ownerName },
              { key: 'r', header: 'Revenue', align: 'right', cell: (r) => money(r.figures.totalRevenue) },
              { key: 'g', header: 'GOP', align: 'right', cell: (r) => money(r.figures.gop) },
              { key: 'f', header: 'Fee', align: 'right', cell: (r) => money(r.figures.managementFee) },
              { key: 'n', header: 'Net payable', align: 'right', cell: (r) => money(r.figures.netPayable) },
              { key: 's', header: 'Status', cell: (r) => <StatusPill tone={TONE[label(r)] ?? 'neutral'}>{label(r)}</StatusPill> },
            ]}
            footer={['Total', '', money(d.rows.reduce((s, r) => s + r.figures.totalRevenue, 0)), money(d.rows.reduce((s, r) => s + r.figures.gop, 0)), money(d.rows.reduce((s, r) => s + r.figures.managementFee, 0)), money(d.rows.reduce((s, r) => s + r.figures.netPayable, 0)), '']}
          />
        )}
      </Card>
    </div>
  )
}
