import type { TransactionOrigin } from '@/domain/finance'
import type { Tone } from '../../ui/Badge'

export const ORIGIN_TONE: Record<TransactionOrigin, Tone> = {
  manual: 'neutral',
  front_desk: 'info',
  transfer: 'info',
  adjustment: 'warning',
  reconciliation: 'warning',
  payroll: 'neutral',
  reversal: 'danger',
  payment: 'success',
  maintenance: 'warning',
  room_service: 'success',
  stock: 'warning',
}
