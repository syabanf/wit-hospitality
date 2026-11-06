import type { LaundryStatus, TaskStatus } from '@/domain/housekeeping'
import type { Tone } from '../../ui/Badge'

export const TASK_TONE: Record<TaskStatus, Tone> = { pending: 'info', in_progress: 'warning', paused: 'danger', done: 'success', dnd: 'accent', refused: 'neutral', cancelled: 'neutral' }

export const LAUNDRY_TONE: Record<LaundryStatus, Tone> = { out: 'warning', returned: 'success' }
