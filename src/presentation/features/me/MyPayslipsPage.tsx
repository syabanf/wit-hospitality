import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card } from '../../ui/Card'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'

export default function MyPayslipsPage() {
  const { people } = useServices()
  const data = useResource('people.home:payslips', () => people.home())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  return (
    <>
      <PageBar fallback="/me" label="My area" />
      {d.payslips.length === 0 ? (
        <EmptyState title="No payslip published yet">HR publishes payslips once a payroll run is closed.</EmptyState>
      ) : (
        <Card className="p-0" aria-label="Payslips">
          <ul className="divide-y divide-line">
            {d.payslips.map((p) => (
              <li key={p.period.id}>
                <Link to={`/me/payslips/${p.period.id}`} className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-raised">
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{p.label}</span>
                    <span className="block text-xs text-muted">{p.line ? `Gross ${money(p.line.gross)} · deductions ${money(p.line.deductions)}` : 'Not on this run'}</span>
                  </span>
                  <span className="shrink-0 font-semibold tabular">{p.line ? money(p.line.net) : ''}</span>
                  <ArrowRight aria-hidden className="size-4 shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}
