import { kpiBand, KPI_BAND_LABEL } from '@/domain/people'
import { shortDay } from '@/lib/dates'
import { percent } from '@/lib/format'
import { ScoreMeter } from '../../charts/ScoreMeter'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { KPI_TONE } from '../shared/tones'

export default function MyKpiPage() {
  const { people } = useServices()
  const data = useResource('people.home:kpi', () => people.home())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const k = d.kpi
  return (
    <>
      <PageBar fallback="/me" label="My area" />
      {!k ? (
        <EmptyState title="No published review yet">Your manager publishes the scorecard at the end of each quarter.</EmptyState>
      ) : (
        <div className="space-y-4">
          <Card aria-label={`KPI ${k.period}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-mono text-xs text-muted">{k.period}</p>
                <Headline className="mt-1">{`Score ${k.score}`}</Headline>
                <p className="mt-1 text-sm text-muted">
                  Reviewed by {k.reviewer}, {shortDay(k.reviewedOn)}
                </p>
              </div>
              <Tag tone={KPI_TONE[kpiBand(k.score)]}>{KPI_BAND_LABEL[kpiBand(k.score)]}</Tag>
            </div>
            <div className="mt-6 flex items-center gap-3">
              <ScoreMeter score={Math.min(100, k.score)} label={`KPI score ${k.period}`} />
              <span className="shrink-0 text-sm text-muted tabular">{k.score} of 120</span>
            </div>
            <FactGrid className="mt-6 grid-cols-3" facts={[['Indicators', k.items.length], ['On target', k.items.filter((i) => i.actual >= i.target).length], ['Below', k.items.filter((i) => i.actual < i.target).length]]} />
            {k.note && <p className="mt-4 rounded-panel bg-info-soft p-3.5 text-sm text-body">{k.note}</p>}
          </Card>
          <Card aria-labelledby="kpi-bars">
            <CardHeader id="kpi-bars" title="Achievement per indicator" />
            <ul className="stagger space-y-3">
              {k.items.map((i, n) => {
                const ratio = i.target ? Math.min(1.2, i.actual / i.target) : 0
                return (
                  <li key={i.name} className="text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 truncate">
                        {i.name} <span className="text-xs text-muted">· weight {i.weight}%</span>
                      </span>
                      <span className={ratio >= 1 ? 'shrink-0 font-medium text-success tabular' : 'shrink-0 font-medium text-danger tabular'}>{percent(ratio, { digits: 0 })}</span>
                    </div>
                    <div className="relative mt-1.5 h-2.5 overflow-hidden rounded-full bg-raised">
                      <span aria-hidden className="absolute inset-y-0 w-px bg-fg/60" style={{ left: `${(1 / 1.2) * 100}%` }} />
                      <span className={ratio >= 1 ? 'block h-full animate-fade rounded-full bg-success' : 'block h-full animate-fade rounded-full bg-accent'} style={{ width: `${(ratio / 1.2) * 100}%`, animationDelay: `${n * 90}ms` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
            <p className="mt-3 text-xs text-muted">The marker is the target; the bar runs to 120% of it.</p>
          </Card>
          <Card aria-labelledby="kpi-items">
            <CardHeader id="kpi-items" title="Indicators" />
            <DataTable
              label="KPI indicators"
              rows={k.items}
              rowKey={(i) => i.name}
              columns={[
                { key: 'name', header: 'Indicator', cell: (i) => i.name },
                { key: 'target', header: 'Target', align: 'right', cell: (i) => `${i.target}${i.unit}` },
                { key: 'actual', header: 'Actual', align: 'right', cell: (i) => `${i.actual}${i.unit}` },
                { key: 'ach', header: 'Achievement', align: 'right', cell: (i) => <span className={i.actual >= i.target ? 'text-success' : 'text-danger'}>{percent(i.target ? i.actual / i.target : 0, { digits: 0 })}</span> },
                { key: 'weight', header: 'Weight', align: 'right', cell: (i) => `${i.weight}%` },
              ]}
            />
            <p className="mt-3 text-xs text-muted">Each indicator counts up to 120% of its target, weighted as shown. 90 and above is on target, 105 and above exceeds it.</p>
          </Card>
        </div>
      )}
    </>
  )
}
