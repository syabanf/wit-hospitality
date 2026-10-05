import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Plus } from 'lucide-react'
import type { ServiceRequestView } from '@/application/views'
import { clockLabel, SERVICE_KIND_LABEL, SERVICE_KINDS, SERVICE_STATUS_LABEL, SERVICE_STATUSES, type ServiceKind, type ServiceStatus } from '@/domain/roomService'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { TableToolbar } from '../../ui/TableToolbar'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { ViewToggle } from '../../ui/ViewToggle'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { KanbanBoard } from './KanbanBoard'
import { SERVICE_TONE } from '../shared/tones'
import { RequestForm } from './RequestForm'

type StatusFilter = ServiceStatus | 'all'
const FILTERS: StatusFilter[] = ['all', ...SERVICE_STATUSES]

/** Housekeeping and guest requests across the villas: open work first, the day's closed work after. */
export default function ServicesPage() {
  const { service } = useServices()
  const toast = useToast()
  const data = useResource('service.list', () => service.list())
  const options = useResource('service.formOptions', () => service.formOptions())
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useLayout()
  const status = (FILTERS.find((f) => f === params.get('status')) ?? 'all') as StatusFilter
  const kind = (SERVICE_KINDS.find((k) => k === params.get('kind')) ?? '') as ServiceKind | ''
  const query = params.get('q') ?? ''
  const creating = params.get('new') === '1'
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined
  const [busy, setBusy] = useState<string | null>(null)

  function update(next: Partial<{ status: StatusFilter; kind: string; q: string; new: string; from: string; to: string }>) {
    const search = new URLSearchParams(params)
    const merged = { status, kind, q: query, new: creating ? '1' : '', from: from ?? '', to: to ?? '', ...next }
    if (merged.status === 'all') search.delete('status')
    else search.set('status', merged.status)
    for (const key of ['kind', 'q', 'new', 'from', 'to'] as const) {
      if (merged[key]) search.set(key, merged[key])
      else search.delete(key)
    }
    if (!merged.new) search.delete('booking')
    search.delete('page')
    setParams(search, { replace: true })
  }

  async function move(r: ServiceRequestView, to: Exclude<ServiceStatus, 'open'>) {
    setBusy(r.id)
    try {
      await service.transition(r.id, to)
      toast({ title: to === 'done' ? `Closed ${r.number}` : to === 'cancelled' ? `Cancelled ${r.number}` : `Started ${r.number}`, description: `${r.unitCode} · ${SERVICE_KIND_LABEL[r.kind]}` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${r.number}`, description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const rows = service.filter(d.list, { status, kind: kind || 'all', query, from, to })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Towels, cleaning, repairs, laundry and transfers per unit. Start a request when someone takes it; mark it done and record the charge.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} cardsLabel="Board" />
          <Button variant="accent" aria-pressed={creating} onClick={() => update({ new: creating ? '' : '1' })}>
            <Plus aria-hidden className="size-4" /> New request
          </Button>
        </div>
      </div>
      {creating && options.data && (
        <Card as="div" aria-label="New request">
          <p className="mb-4 text-lg font-semibold tracking-tight">New request</p>
          <RequestForm
            catalog={options.data.catalog}
            inHouse={options.data.inHouse}
            initialBookingId={params.get('booking') ?? undefined}
            initialUnitId={params.get('unit') ?? undefined}
            save={(input) => service.create(input)}
            onDone={() => {
              toast({ title: 'Request created', description: 'It is open for the team.' })
              update({ new: '' })
              data.reload()
            }}
            onCancel={() => update({ new: '' })}
          />
        </Card>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Open" value={d.open} hint="Waiting for someone" active={status === 'open'} onClick={() => update({ status: status === 'open' ? 'all' : 'open' })} />
        <StatTile label="In progress" value={d.inProgress} hint="Being handled" active={status === 'in_progress'} onClick={() => update({ status: status === 'in_progress' ? 'all' : 'in_progress' })} />
        <StatTile label="Urgent" value={d.urgent} hint="Guest waiting" to="/services?status=open" />
        <StatTile label="Done today" value={d.doneToday} active={status === 'done'} onClick={() => update({ status: status === 'done' ? 'all' : 'done' })} />
        <StatTile label="Charges to record" value={money(d.chargesOpen)} hint="Not yet in the cashbox" to="/services?status=done" className="col-span-2 sm:col-span-1" />
      </div>

      <Card className="p-0">
        <TableToolbar
          chips={FILTERS.map((f) => ({ value: f, label: f === 'all' ? 'All' : SERVICE_STATUS_LABEL[f], count: f === 'all' ? d.list.length : d.list.filter((r) => r.status === f).length }))}
          chip={status}
          onChip={(f) => update({ status: f })}
          summary={`${rows.length} of ${d.list.length} requests`}
          search={<Input className="h-10" placeholder="Unit, guest, note or staff" aria-label="Search requests" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={<Select aria-label="Kind" value={kind} options={[{ value: '', label: 'All kinds' }, ...SERVICE_KINDS.map((k) => ({ value: k, label: SERVICE_KIND_LABEL[k] }))]} onChange={(e) => update({ kind: e.target.value })} />}
          date={<DateRangeFilter today={d.today} label="Requested" value={{ from, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={status !== 'all' || !!kind || !!query || !!from || !!to}
          onClear={() => update({ status: 'all', kind: '', q: '', from: '', to: '' })}
        />
        {layout === 'cards' ? (
          <KanbanBoard requests={rows} today={d.today} busy={busy} onMove={(r, to) => void move(r, to)} />
        ) : (
          <ListTable
            label="Requests"
            rows={rows}
            rowKey={(r) => r.id}
            href={(r) => `/services/${r.id}`}
            exportName="service-requests"
            exportDate={d.today}
            empty={<EmptyState title="No request matches" action={<Button variant="solid" size="sm" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>} />}
            columns={[
              { key: 'no', header: 'Request', cell: (r) => <span className="font-mono text-xs">{r.number}</span>, value: (r) => r.number },
              { key: 'when', header: 'When', cell: (r) => (r.requestedOn === d.today ? `Today ${clockLabel(r.requestedAt)}` : shortDay(r.requestedOn)), value: (r) => `${r.requestedOn} ${clockLabel(r.requestedAt)}` },
              { key: 'unit', header: 'Unit', cell: (r) => <span className="font-mono">{r.unitCode}</span>, value: (r) => r.unitCode },
              { key: 'kind', header: 'Kind', cell: (r) => <span className="flex items-center gap-2">{SERVICE_KIND_LABEL[r.kind]}{r.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}</span>, value: (r) => SERVICE_KIND_LABEL[r.kind] },
              { key: 'guest', header: 'Guest', cell: (r) => r.guestName ?? <span className="text-muted">Housekeeping</span>, value: (r) => r.guestName ?? '', hide: 'lg' },
              { key: 'note', header: 'Details', cell: (r) => <span className="line-clamp-1">{r.note}</span>, value: (r) => r.note, hide: 'xl' },
              { key: 'who', header: 'Assigned', cell: (r) => r.assignee || <span className="text-muted">Nobody yet</span>, value: (r) => r.assignee, hide: 'lg' },
              { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={SERVICE_TONE[r.status]}>{SERVICE_STATUS_LABEL[r.status]}</StatusPill>, value: (r) => SERVICE_STATUS_LABEL[r.status] },
              { key: 'charge', header: 'Charge', align: 'right', cell: (r) => (r.charge ? <span className="font-semibold tabular">{money(r.charge)}</span> : <span className="text-muted">Included</span>), value: (r) => r.charge, total: (sum) => money(sum) },
            ]}
            card={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    <span className="font-mono">{r.unitCode}</span> · {SERVICE_KIND_LABEL[r.kind]}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {r.guestName ?? 'Housekeeping'} · {r.note}
                  </p>
                </div>
                <StatusPill tone={SERVICE_TONE[r.status]}>{SERVICE_STATUS_LABEL[r.status]}</StatusPill>
              </div>
            )}
          />
        )}
      </Card>
    </div>
  )
}
