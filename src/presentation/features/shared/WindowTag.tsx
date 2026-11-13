import { windowLabel, type ServiceWindow, type WindowMode } from '@/domain/hospitality'
import { Tag, type Tone } from '../../ui/Badge'

const TONE: Record<WindowMode, Tone> = { scheduled: 'neutral', window: 'info', dnd: 'danger' }

/** When housekeeping may go in: on schedule, a window, or do not disturb in red. */
export function WindowTag({ window, className }: { window: ServiceWindow; className?: string }) {
  return (
    <Tag tone={TONE[window.mode]} className={className}>
      {window.mode === 'window' ? `Service ${windowLabel(window)}` : windowLabel(window)}
    </Tag>
  )
}
