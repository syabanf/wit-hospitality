import type { AgingBucket, LinkStatus, PaymentMethod, PaymentStatus } from '@/domain/payment'
import type { Tone } from '../../ui/Badge'

export const PAYMENT_TONE: Record<PaymentStatus, Tone> = { pending: 'warning', paid: 'success', failed: 'danger', expired: 'neutral', refunded: 'info', cancelled: 'neutral' }
export const LINK_TONE: Record<LinkStatus, Tone> = { pending: 'warning', paid: 'success', failed: 'danger', expired: 'neutral', cancelled: 'neutral' }
export const AGING_TONE: Record<AgingBucket, Tone> = { not_due: 'neutral', d0_7: 'warning', d8_30: 'accent', d30: 'danger' }
/** Chart slot per method, so a method keeps its colour on every chart. */
export const METHOD_SLOT: Record<PaymentMethod, number> = { cash: 1, bank_transfer: 2, qris: 3, virtual_account: 4, card: 5, airbnb_payout: 0 }

/** The guest-facing URL of a link, on this host. */
export const payUrl = (token: string) => `${typeof window === 'undefined' ? '' : window.location.origin}/pay/${token}`
