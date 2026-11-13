import { Link, useSearchParams } from 'react-router'
import { Plus, Search } from 'lucide-react'
import { filterGroups, GROUP_BILLING_LABEL, GROUP_STATUS_LABEL, GROUP_STATUSES, type GroupStatus } from '@/domain/group'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { GROUP_TONE } from '../shared/tones'

type StatusFilter = GroupStatus | 'all'
const FILTERS: StatusFilter[] = ['all', ...GROUP_STATUSES]

/** Group reservations, live ones first, with their stays, guests and what they still owe. */
export default function GroupsPage() {
  const { groups } = useServices()
  const data = useResource('groups.list', () => groups.list())
  const [params, setParams] = useSearchParams()
  const status = (FILTERS.find((f) => f === params.get('status')) ?? 'all') as StatusFilter
  const query = params.get('q') ?? ''

  function update(next: { status?: StatusFilter; q?: string }) {
    const merged = { status, q: query, ...next }
    const search = new URLSearchParams()
    if (merged.status !== 'all') search.set('status', merged.status)
    if (merged.q) search.set('q', merged.q)
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const rows = filterGroups(d.rows, { status, query })

  return (
    <>
      <PageBar
        fallback="/bookings"
        label="Bookings"
        actions={
          <Link to="/bookings/groups/new" className={buttonStyles({ variant: 'accent' })}>
            <Plus aria-hidden className="size-4" /> Group booking
          </Link>
        }
      />
      <Card className="p-0">
        <TableToolbar
          chips={FILTERS.map((f) => ({ value: f, label: f === 'all' ? 'All' : GROUP_STATUS_LABEL[f], count: d.counts[f] }))}
          chip={status}
          onChip={(f) => update({ status: f })}
          summary={`${rows.length} of ${d.rows.length} groups`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Group, code or lead guest" aria-label="Search groups" value={query} onChange={(e) => update({ q: e.target.value })} />}
          active={status !== 'all' || !!query}
          onClear={() => update({ status: 'all', q: '' })}
        />
        <ListTable
          label="Group bookings"
          rows={rows}
          rowKey={(r) => r.group.id}
          href={(r) => `/bookings/groups/${r.group.id}`}
          defaultSort={{ key: 'in', dir: 'asc' }}
          exportName="group-bookings"
          exportDate={d.today}
          empty={<EmptyState title="No group matches">Nothing fits this status and search.</EmptyState>}
          columns={[
            {
              key: 'name',
              header: 'Group',
              cell: (r) => (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {r.group.name}
                  {r.group.wholeVilla && <Tag tone="info">Whole villa</Tag>}
                </span>
              ),
              value: (r) => r.group.name,
            },
            { key: 'code', header: 'Code', cell: (r) => <span className="font-mono text-xs text-muted">{r.group.code}</span>, value: (r) => r.group.code, hide: 'xl' },
            { key: 'lead', header: 'Lead guest', cell: (r) => r.leadName, value: (r) => r.leadName, hide: 'lg' },
            { key: 'villa', header: 'Villa', cell: (r) => r.villaNames, value: (r) => r.villaNames, hide: 'lg' },
            { key: 'in', header: 'Arrives', cell: (r) => shortDay(r.checkIn), value: (r) => r.checkIn },
            { key: 'stays', header: 'Stays', align: 'right', cell: (r) => <span className="tabular">{r.stays.length}</span>, value: (r) => r.stays.length, total: (sum) => sum },
            { key: 'billing', header: 'Billing', cell: (r) => GROUP_BILLING_LABEL[r.group.billing], value: (r) => GROUP_BILLING_LABEL[r.group.billing], hide: 'xl' },
            { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={GROUP_TONE[r.status]}>{GROUP_STATUS_LABEL[r.status]}</StatusPill>, value: (r) => GROUP_STATUS_LABEL[r.status] },
            { key: 'total', header: 'Total', align: 'right', cell: (r) => <span className="font-semibold tabular">{money(r.total)}</span>, value: (r) => r.total, total: (sum) => money(sum) },
            { key: 'owed', header: 'Still owed', align: 'right', cell: (r) => <span className="tabular text-muted">{money(r.outstanding)}</span>, value: (r) => r.outstanding, total: (sum) => money(sum), hide: 'lg' },
          ]}
          card={(r) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.group.name}</p>
                {r.group.wholeVilla && <Tag tone="info">Whole villa</Tag>}
                <p className="text-xs text-muted">
                  {shortDay(r.checkIn)} · {plural(r.stays.length, 'stay')} · {r.villaNames}
                </p>
              </div>
              <div className="flex flex-col items-end gap-1.5">
                <span className="text-sm font-semibold tabular">{money(r.total)}</span>
                <StatusPill tone={GROUP_TONE[r.status]}>{GROUP_STATUS_LABEL[r.status]}</StatusPill>
              </div>
            </div>
          )}
        />
      </Card>
    </>
  )
}
