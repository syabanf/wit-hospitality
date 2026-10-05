import { Link } from 'react-router'
import type { BookingView } from '@/application/views'
import { BOOKING_STATUS_LABEL } from '@/domain/booking'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { Avatar } from '../../ui/Avatar'
import { StatusPill } from '../../ui/Badge'
import { BOOKING_TONE } from './tones'

/** A stacked list of bookings, each row a link to its record. `trailing` renders an action beside the status. */
export function BookingRows({
  bookings,
  trailing,
  empty,
  primary = (b) => b.guestName,
}: {
  bookings: readonly BookingView[]
  trailing?: (b: BookingView) => React.ReactNode
  empty: string
  /** The bold line; the guest by default, the unit on a guest's own page. */
  primary?: (b: BookingView) => string
}) {
  if (bookings.length === 0) return <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {bookings.map((b) => (
        <li key={b.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
          <Avatar name={b.guestName} size="sm" />
          <div className="min-w-0 flex-1">
            <Link to={`/bookings/${b.id}`} className="block truncate font-medium hover:underline">
              {primary(b)}
            </Link>
            <p className="truncate text-xs text-muted">
              {b.unitCode} · {shortDay(b.checkIn)} to {shortDay(b.checkOut)} · {plural(b.nights, 'night')} · {b.sourceLabel}
            </p>
          </div>
          {trailing ? trailing(b) : <StatusPill tone={BOOKING_TONE[b.status]}>{BOOKING_STATUS_LABEL[b.status]}</StatusPill>}
        </li>
      ))}
    </ul>
  )
}
