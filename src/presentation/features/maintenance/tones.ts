import type { AssetStatus, HousekeepingState, PlanState, WorkOrderPriority, WorkOrderStatus } from '@/domain/maintenance'
import type { Tone } from '../../ui/Badge'

export const WORK_ORDER_TONE: Record<WorkOrderStatus, Tone> = {
  open: 'info',
  scheduled: 'info',
  in_progress: 'warning',
  on_hold: 'danger',
  done: 'success',
  verified: 'success',
  cancelled: 'neutral',
}

export const PRIORITY_TONE: Record<WorkOrderPriority, Tone> = { low: 'neutral', normal: 'info', high: 'warning', urgent: 'accent' }

export const HOUSEKEEPING_TONE: Record<HousekeepingState, Tone> = { dirty: 'danger', cleaning: 'warning', inspected: 'info', ready: 'success', out_of_order: 'neutral' }

export const ASSET_TONE: Record<AssetStatus, Tone> = { in_service: 'success', under_repair: 'warning', retired: 'neutral' }

export const PLAN_TONE: Record<PlanState, Tone> = { overdue: 'accent', due: 'warning', later: 'success', paused: 'neutral' }

/** Chart slot per work order status, so the donut and the legend agree. */
export const WORK_ORDER_SLOT: Record<WorkOrderStatus, number> = { open: 1, scheduled: 5, in_progress: 2, on_hold: 3, done: 4, verified: 4, cancelled: 0 }

/** Order of the kanban columns; on hold and cancelled show as tags inside them. */
export const BOARD_COLUMNS: ReadonlyArray<{ status: WorkOrderStatus; hint: string }> = [
  { status: 'open', hint: 'Reported' },
  { status: 'scheduled', hint: 'Booked in' },
  { status: 'in_progress', hint: 'Being fixed' },
  { status: 'done', hint: 'Waiting for a check' },
]
