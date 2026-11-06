import type { ShiftStatus } from '@/domain/cashier'
import { money } from '@/lib/format'
import type { Tone } from '../../ui/Badge'

export const SHIFT_TONE: Record<ShiftStatus, Tone> = { open: 'info', awaiting_signoff: 'warning', closed: 'success' }

/** "Over Rp 3.000", "Short Rp 25.000" or "Matched". */
export const differenceText = (d: number | null) => (d === null ? 'Not counted' : d === 0 ? 'Matched' : `${d > 0 ? 'Over' : 'Short'} ${money(Math.abs(d))}`)
