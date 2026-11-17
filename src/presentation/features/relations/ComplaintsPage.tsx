import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { Plus } from 'lucide-react'
import { COMPLAINT_CATEGORIES, COMPLAINT_CATEGORY_LABEL, COMPLAINT_STATUS_LABEL, COMPLAINT_STATUSES, COMPENSATION_STATUS_LABEL, isOpenComplaint, SEVERITIES, SEVERITY_LABEL, type ComplaintStatus } from '@/domain/relations'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { StatTile } from '../../ui/StatTile'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { cn } from '@/lib/cn'
import { ComplaintForm } from './ComplaintForm'
import { COMPENSATION_TONE, COMPLAINT_TONE, SEVERITY_TONE, when } from './shared'

type Chip = ComplaintStatus | 'active' | 'all'

/** Guest complaints across the properties: what is open, who owns it, and what the guest got. */
export default function ComplaintsPage() {
  const { complaints } = useServices()
  const { can } = useAccess()
  const navigate = useNavigate()
  const data = useResource('complaints.list', () => complaints.list())
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const chip = (params.get('status') ?? 'active') as Chip
  const query = params.get('q') ?? ''
  const category = params.get('category') ?? ''
  const severity = params.get('severity') ?? ''
  const onlyWaiting = params.get('waiting') === '1'
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const { complaints: all, catalog, guests, stays, today } = data.data
  const q = query.trim().toLowerCase()
  const byStatus = (c: (typeof all)[number]) => chip === 'all' || (chip === 'active' ? isOpenComplaint(c.status) : c.status === chip)
  const rows = all.filter((c) => byStatus(c) && (!onlyWaiting || c.compensation?.status === 'pending_approval') && (!category || c.category === category) && (!severity || c.severity === severity) && (!q || [c.number, c.description, c.guestName, c.villaName, c.owner, c.bookingCode ?? '', c.unitCode ?? ''].some((v) => v.toLowerCase().includes(q))))
  const urgent = all.filter((c) => isOpenComplaint(c.status) && c.severity === 'high')
  const waiting = all.filter((c) => c.compensation?.status === 'pending_approval')
  const month = today.slice(0, 7)
  const chips = [
    { value: 'active' as const, label: 'Open and in progress', count: all.filter((c) => isOpenComplaint(c.status)).length },
    ...COMPLAINT_STATUSES.map((s) => ({ value: s, label: COMPLAINT_STATUS_LABEL[s], count: all.filter((c) => c.status === s).length })),
    { value: 'all' as const, label: 'All', count: all.length },
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Log what a guest complained about, give it an owner and follow it up to a resolution. Guests can also tell you from their stay page.</p>
        {can('guest', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Log a complaint
          </Button>
        )}
      </div>
      {adding && (
        <Card as="div" aria-label="Log a complaint">
          <ComplaintForm catalog={catalog} guests={guests} stays={stays} today={today} onCancel={() => setAdding(false)} onDone={(c) => navigate(`/complaints/${c.id}`)} />
        </Card>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Open, high severity" value={urgent.length} active={chip === 'active' && severity === 'high' && !onlyWaiting} onClick={() => setParams(new URLSearchParams({ severity: 'high' }), { replace: true })} hint="Answer these first" />
        <StatTile label="Open and in progress" value={chips[0]!.count} active={chip === 'active' && !severity && !onlyWaiting && !category && !query} onClick={() => setParams(new URLSearchParams(), { replace: true })} />
        <StatTile label="Credits waiting" value={waiting.length} hint="Past the limit, for a manager" active={onlyWaiting} onClick={() => setParams(new URLSearchParams({ status: 'all', waiting: '1' }), { replace: true })} />
        <StatTile label="Received this month" value={all.filter((c) => c.receivedAt.startsWith(month)).length} onClick={() => setParams(new URLSearchParams({ status: 'all' }), { replace: true })} />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={chips}
          chip={chip}
          onChip={(v) => update('status', v === 'active' ? '' : v)}
          summary={`${rows.length} of ${all.length} complaints`}
          search={<Input className="h-10" placeholder="Number, guest, villa or what they said" aria-label="Search complaints" value={query} onChange={(e) => update('q', e.target.value)} />}
          filters={
            <>
              <Select aria-label="Category" value={category} onChange={(e) => update('category', e.target.value)} options={[{ value: '', label: 'Every category' }, ...COMPLAINT_CATEGORIES.map((c) => ({ value: c, label: COMPLAINT_CATEGORY_LABEL[c] }))]} />
              <Select aria-label="Severity" value={severity} onChange={(e) => update('severity', e.target.value)} options={[{ value: '', label: 'Every severity' }, ...SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))]} />
            </>
          }
          active={!!query || chip !== 'active' || !!category || !!severity || onlyWaiting}
          onClear={() => setParams(new URLSearchParams(), { replace: true })}
        />
        {rows.length === 0 ? (
          <div className="p-4">
            <EmptyState title="Nothing here">No complaint matches these filters.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((c) => {
              const hot = isOpenComplaint(c.status) && c.severity === 'high'
              return (
                <li key={c.id} className={cn('relative px-4 py-4 text-sm hover:bg-raised', hot && 'border-l-4 border-l-accent')}>
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        <Link to={`/complaints/${c.id}`} className="after:absolute after:inset-0">
                          <span className="mr-2 font-mono text-xs text-muted">{c.number}</span>
                          {COMPLAINT_CATEGORY_LABEL[c.category]}: {c.guestName}
                        </Link>
                      </p>
                      <p className="line-clamp-2 text-body">{c.description}</p>
                      <p className="text-xs text-muted">
                        {when(c.receivedAt)} · {c.villaName}
                        {c.unitCode && `, ${c.unitCode}`}
                        {c.bookingCode && ` · ${c.bookingCode}`} · owner {c.owner}
                        {c.source === 'stay_page' && ' · from the stay page'}
                        {c.resolutionHours !== null && ` · resolved in ${c.resolutionHours} h`}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Tag tone={SEVERITY_TONE[c.severity]}>{SEVERITY_LABEL[c.severity]}</Tag>
                      <Tag tone={COMPLAINT_TONE[c.status]}>{COMPLAINT_STATUS_LABEL[c.status]}</Tag>
                      {c.compensation && <Tag tone={COMPENSATION_TONE[c.compensation.status]}>{COMPENSATION_STATUS_LABEL[c.compensation.status]}</Tag>}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </div>
  )
}
