import type { BookingView } from '@/application/views'
import { BOOKING_STATUS_LABEL } from '@/domain/booking'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { StatusPill } from '../../ui/Badge'
import { ListTable } from '../../ui/ListTable'
import { EmptyState } from '../../ui/States'
import { BOOKING_TONE } from './tones'

interface BookingTableProps {
  rows: readonly BookingView[]
  label: string
  empty?: React.ReactNode
  exportName?: string
  exportDate?: string
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
}

/** The one booking table: guest, code, unit, dates, nights, source, status, total. Rows open the record. */
export function BookingTable({ rows, label, empty, exportName, exportDate, defaultSort = { key: 'in', dir: 'asc' } }: BookingTableProps) {
  return (
    <ListTable
      label={label}
      rows={rows}
      rowKey={(b) => b.id}
      href={(b) => `/bookings/${b.id}`}
      defaultSort={defaultSort}
      exportName={exportName}
      exportDate={exportDate}
      empty={empty ?? <EmptyState title="No bookings" />}
      columns={[
        { key: 'guest', header: 'Guest', cell: (b) => b.guestName, value: (b) => b.guestName },
        { key: 'code', header: 'Code', cell: (b) => <span className="font-mono text-xs text-muted">{b.code}</span>, value: (b) => b.code, hide: 'xl' },
        { key: 'unit', header: 'Unit', cell: (b) => <span className="font-mono">{b.unitCode}</span>, value: (b) => b.unitCode },
        { key: 'in', header: 'Check-in', cell: (b) => shortDay(b.checkIn), value: (b) => b.checkIn },
        { key: 'out', header: 'Check-out', cell: (b) => shortDay(b.checkOut), value: (b) => b.checkOut, hide: 'lg' },
        { key: 'n', header: 'Nights', align: 'right', cell: (b) => <span className="tabular">{b.nights}</span>, value: (b) => b.nights, hide: 'lg', total: (sum) => sum },
        { key: 'src', header: 'Source', cell: (b) => b.sourceLabel, value: (b) => b.sourceLabel, hide: 'xl' },
        { key: 'status', header: 'Status', cell: (b) => <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>, value: (b) => BOOKING_STATUS_LABEL[b.status] },
        { key: 'total', header: 'Total', align: 'right', cell: (b) => <span className="font-semibold tabular">{money(b.total)}</span>, value: (b) => b.total, total: (sum) => money(sum) },
      ]}
      card={(b) => (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{b.guestName}</p>
            <p className="text-xs text-muted">
              <span className="font-mono">{b.unitCode}</span> · {shortDay(b.checkIn)} · {plural(b.nights, 'night')} · {b.sourceLabel}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <span className="text-sm font-semibold tabular">{money(b.total)}</span>
            <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>
          </div>
        </div>
      )}
    />
  )
}
