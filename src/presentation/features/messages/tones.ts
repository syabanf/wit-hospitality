import type { MessageStatus } from '@/domain/messaging'
import type { PreCheckInStatus } from '@/domain/precheckin'
import type { Tone } from '../../ui/Badge'

export const MESSAGE_TONE: Record<MessageStatus, Tone> = { queued: 'neutral', sent: 'info', delivered: 'success', read: 'success', failed: 'danger' }
export const PRECHECKIN_TONE: Record<PreCheckInStatus, Tone> = { not_started: 'neutral', submitted: 'warning', verified: 'success' }
