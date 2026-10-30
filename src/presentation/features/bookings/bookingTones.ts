import type { PaymentStatus } from '@/domain/booking'
import type { Tone } from '../../ui/Badge'

export const PAYMENT_TONE: Record<PaymentStatus, Tone> = { unpaid: 'danger', partial: 'warning', paid: 'success' }
