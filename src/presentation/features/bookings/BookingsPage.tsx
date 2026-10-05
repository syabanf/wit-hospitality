import { Link, useSearchParams } from 'react-router'
import { Plus, Search } from 'lucide-react'
import { BOOKING_STATUS_LABEL, BOOKING_STATUSES, filterBookings, type BookingStatus } from '@/domain/booking'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { TableToolbar } from '../../ui/TableToolbar'
import { Input, Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { BookingTable } from '../shared/BookingTable'

type StatusFilter = BookingStatus | 'all'
const FILTERS: StatusFilter[] = ['all', ...BOOKING_STATUSES]

/** Every booking, with status chips, a source select and search kept in the URL. */
export default function BookingsPage() {
  const { booking } = useServices()
  const data = useResource('booking.list', () => booking.list())
  const [params, setParams] = useSearchParams()
  const status = (FILTERS.find((f) => f === params.get('status')) ?? 'all') as StatusFilter
  const source = params.get('source') ?? ''
  const query = params.get('q') ?? ''
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined

  function update(next: { status?: StatusFilter; source?: string; q?: string; from?: string; to?: string }) {
    const merged = { status, source, q: query, from, to, ...next }
    const search = new URLSearchParams()
    if (merged.status !== 'all') search.set('status', merged.status)
    for (const key of ['source', 'q', 'from', 'to'] as const) if (merged[key]) search.set(key, merged[key] as string)
    if (params.get('layout')) search.set('layout', params.get('layout') as string)
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const rows = filterBookings(d.list, { status, source: source || undefined, query, from, to })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Live stays first, then arrivals by date. Confirm a draft, check a guest in or out from the record.</p>
        <Link to="/bookings/new" className={buttonStyles({ variant: 'accent' })}>
          <Plus aria-hidden className="size-4" /> New booking
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Arriving today" value={d.arriving} active={status === 'confirmed'} onClick={() => update({ status: status === 'confirmed' ? 'all' : 'confirmed' })} />
        <StatTile label="In house" value={d.inHouse} active={status === 'checked_in'} onClick={() => update({ status: status === 'checked_in' ? 'all' : 'checked_in' })} />
        <StatTile label="Departing today" value={d.departing} hint="Check-out this morning" to="/?view=operational" />
        <StatTile label="Drafts" value={d.drafts} active={status === 'draft'} onClick={() => update({ status: status === 'draft' ? 'all' : 'draft' })} />
      </div>

      <Card className="p-0">
        <TableToolbar
          chips={FILTERS.map((f) => ({ value: f, label: f === 'all' ? 'All' : BOOKING_STATUS_LABEL[f], count: d.counts[f] }))}
          chip={status}
          onChip={(f) => update({ status: f })}
          summary={`${rows.length} of ${d.list.length} bookings`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Guest, code or unit" aria-label="Search bookings" value={query} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <Select aria-label="Source" value={source} options={[{ value: '', label: 'All sources' }, ...d.sources.map((s) => ({ value: s.id, label: s.label }))]} onChange={(e) => update({ source: e.target.value })} />
          }
          date={<DateRangeFilter today={d.today} label="Stay" value={{ from, to }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={status !== 'all' || !!source || !!query || !!from || !!to}
          onClear={() => update({ status: 'all', source: '', q: '', from: '', to: '' })}
        />
        <BookingTable
          label="Bookings"
          rows={rows}
          defaultSort={{ key: 'in', dir: 'desc' }}
          exportName="bookings"
          exportDate={d.today}
          empty={
            <EmptyState
              title="No booking matches"
              action={
                <Button variant="solid" size="sm" onClick={() => update({ status: 'all', source: '', q: '', from: '', to: '' })}>
                  Clear filters
                </Button>
              }
            >
              Nothing fits this status, source and search.
            </EmptyState>
          }
        />
      </Card>
    </div>
  )
}
