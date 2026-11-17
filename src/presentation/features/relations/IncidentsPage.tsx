import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Plus } from 'lucide-react'
import { INCIDENT_KIND_LABEL, INCIDENT_KINDS, INCIDENT_STATUS_LABEL, INCIDENT_STATUSES, SEVERITY_LABEL, type IncidentStatus } from '@/domain/relations'
import { cn } from '@/lib/cn'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { IncidentForm } from './IncidentForm'
import { INCIDENT_TONE, SEVERITY_TONE, when } from './shared'

type Chip = IncidentStatus | 'active' | 'all'

/** The incident log: accidents, thefts, damage, security, medical and safety events, to the manager's sign-off. */
export default function IncidentsPage() {
  const { incidents } = useServices()
  const { can } = useAccess()
  const navigate = useNavigate()
  const data = useResource('incidents.list', () => incidents.list())
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const chip = (params.get('status') ?? 'active') as Chip
  const query = params.get('q') ?? ''
  const kind = params.get('kind') ?? ''
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { incidents: all, catalog, stays, today } = data.data
  const q = query.trim().toLowerCase()
  const rows = all.filter((i) => (chip === 'all' || (chip === 'active' ? i.status !== 'closed' : i.status === chip)) && (!kind || i.kind === kind) && (!q || [i.number, i.description, i.villaName, i.area, i.bookingCode ?? '', ...i.people.map((p) => p.name)].some((v) => v.toLowerCase().includes(q))))
  const chips = [
    { value: 'active' as const, label: 'Not closed', count: all.filter((i) => i.status !== 'closed').length },
    ...INCIDENT_STATUSES.map((s) => ({ value: s, label: INCIDENT_STATUS_LABEL[s], count: all.filter((i) => i.status === s).length })),
    { value: 'all' as const, label: 'All', count: all.length },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Anything that happened at a property that is not a guest's complaint. A manager signs each one off; damage a guest caused goes on their folio.</p>
        {can('guest', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Log an incident
          </Button>
        )}
      </div>
      {adding && (
        <Card as="div" aria-label="Log an incident">
          <IncidentForm catalog={catalog} stays={stays} today={today} onCancel={() => setAdding(false)} onDone={(i) => navigate(`/incidents/${i.id}`)} />
        </Card>
      )}
      <Card className="p-0">
        <TableToolbar
          chips={chips}
          chip={chip}
          onChip={(v) => update('status', v === 'active' ? '' : v)}
          summary={`${rows.length} of ${all.length} incidents`}
          search={<Input className="h-10" placeholder="Number, place, person or what happened" aria-label="Search incidents" value={query} onChange={(e) => update('q', e.target.value)} />}
          filters={<Select aria-label="Kind" value={kind} onChange={(e) => update('kind', e.target.value)} options={[{ value: '', label: 'Every kind' }, ...INCIDENT_KINDS.map((k) => ({ value: k, label: INCIDENT_KIND_LABEL[k] }))]} />}
          active={!!query || chip !== 'active' || !!kind}
          onClear={() => setParams(new URLSearchParams(), { replace: true })}
        />
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Nothing here">No incident matches these filters.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((i) => (
              <li key={i.id} className={cn('relative px-4 py-4 text-sm hover:bg-raised', i.urgent && 'border-l-4 border-l-accent')}>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">
                      <Link to={`/incidents/${i.id}`} className="after:absolute after:inset-0">
                        <span className="mr-2 font-mono text-xs text-muted">{i.number}</span>
                        {INCIDENT_KIND_LABEL[i.kind]}
                      </Link>
                    </p>
                    <p className="line-clamp-2 text-body">{i.description}</p>
                    <p className="text-xs text-muted">
                      {when(i.occurredAt)} · {i.villaName}
                      {i.unitCode && `, ${i.unitCode}`}
                      {i.area && ` · ${i.area}`}
                      {i.bookingCode && ` · ${i.bookingCode}`}
                      {i.policeCalled && ' · police called'}
                      {i.doctorCalled && ' · doctor called'}
                      {i.charge && ` · charged ${money(i.charge.amount)}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Tag tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Tag>
                    <Tag tone={INCIDENT_TONE[i.status]}>{INCIDENT_STATUS_LABEL[i.status]}</Tag>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
