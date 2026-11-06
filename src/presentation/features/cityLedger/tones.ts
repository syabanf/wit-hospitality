import type { InvoiceState } from '@/domain/cityLedger'
import type { Tone } from '../../ui/Badge'

export const INVOICE_TONE: Record<InvoiceState, Tone> = { open: 'info', partly_paid: 'warning', paid: 'success', overdue: 'danger' }
