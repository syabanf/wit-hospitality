import type { BookingStatus, NightState } from '@/domain/booking'
import type { TransactionStatus } from '@/domain/finance'
import type { ServiceStatus } from '@/domain/roomService'
import type { Tone } from '../../ui/Badge'

export const BOOKING_TONE: Record<BookingStatus, Tone> = {
  draft: 'neutral',
  confirmed: 'info',
  checked_in: 'success',
  checked_out: 'neutral',
  cancelled: 'danger',
}

export const TRANSACTION_TONE: Record<TransactionStatus, Tone> = {
  draft: 'neutral',
  submitted: 'warning',
  approved: 'info',
  posted: 'success',
  reversed: 'danger',
}

export const SERVICE_TONE: Record<ServiceStatus, Tone> = { open: 'info', in_progress: 'warning', done: 'success', cancelled: 'neutral' }

/** Night cells and unit chips: occupied is the inverted surface, blocked is hatched, closed is greyed. */
export const NIGHT_CLASS: Record<NightState, string> = {
  free: 'border border-line-strong bg-raised text-fg',
  occupied: 'bg-invert text-on-invert',
  blocked: 'hatch border border-line-strong bg-control text-muted',
  closed: 'bg-control text-subtle line-through',
}

export const NIGHT_TONE: Record<NightState, Tone> = { free: 'success', occupied: 'neutral', blocked: 'warning', closed: 'danger' }

export const NIGHT_LABEL: Record<NightState, string> = { free: 'Free', occupied: 'Occupied', blocked: 'Blocked', closed: 'Closed' }
