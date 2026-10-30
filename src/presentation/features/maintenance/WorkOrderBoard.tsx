import { useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import { Check, GripVertical, Play, ShieldCheck } from 'lucide-react'
import type { WorkOrderView } from '@/application/views'
import { canTransitionWorkOrder, PRIORITY_LABEL, WORK_ORDER_STATUS_LABEL, type WorkOrderStatus } from '@/domain/maintenance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { BOARD_COLUMNS, PRIORITY_TONE } from './tones'

type Move = Exclude<WorkOrderStatus, 'open'>

/** The column a card sits in: on hold stays beside the work, verified beside done. */
const columnOf = (status: WorkOrderStatus): WorkOrderStatus => (status === 'on_hold' ? 'in_progress' : status === 'verified' ? 'done' : status)

/** The one-tap step on a card. */
function nextMove(w: WorkOrderView, canVerify: boolean): { to: Move; label: string } | null {
  if (w.status === 'open' || w.status === 'scheduled') return { to: 'in_progress', label: 'Start' }
  if (w.status === 'on_hold') return { to: 'in_progress', label: 'Resume' }
  if (w.status === 'in_progress') return { to: 'done', label: 'Mark done' }
  if (w.status === 'done' && canVerify) return { to: 'verified', label: 'Verify' }
  return null
}

interface WorkOrderBoardProps {
  rows: readonly WorkOrderView[]
  busy: string | null
  canEdit: boolean
  canVerify: boolean
  onMove: (w: WorkOrderView, to: Move) => void
}

/** Open, Scheduled, In progress and Done as columns; drag a card or use its button. */
export function WorkOrderBoard({ rows, busy, canEdit, canVerify, onMove }: WorkOrderBoardProps) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<WorkOrderStatus | null>(null)
  const target = dragging ? rows.find((w) => w.id === dragging) : undefined
  const accepts = (status: WorkOrderStatus) => Boolean(canEdit && target && status !== 'open' && columnOf(target.status) !== status && canTransitionWorkOrder(target, status))

  function drop(e: DragEvent, status: WorkOrderStatus) {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain') || dragging
    setOver(null)
    setDragging(null)
    const w = rows.find((x) => x.id === id)
    if (w && status !== 'open' && canTransitionWorkOrder(w, status)) onMove(w, status as Move)
  }

  return (
    <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
      {BOARD_COLUMNS.map((col) => {
        const cards = rows.filter((w) => columnOf(w.status) === col.status)
        return (
          <section
            key={col.status}
            aria-label={WORK_ORDER_STATUS_LABEL[col.status]}
            onDragOver={(e) => {
              if (!accepts(col.status)) return
              e.preventDefault()
              setOver(col.status)
            }}
            onDragLeave={() => setOver((o) => (o === col.status ? null : o))}
            onDrop={(e) => drop(e, col.status)}
            className={cn('flex min-h-40 min-w-0 flex-col rounded-panel bg-raised p-3 transition-colors', over === col.status && 'ring-2 ring-accent', dragging && !accepts(col.status) && target && columnOf(target.status) !== col.status && 'opacity-60')}
          >
            <header className="mb-3 flex items-center justify-between px-1">
              <p className="text-sm font-semibold">
                {WORK_ORDER_STATUS_LABEL[col.status]} <span className="ml-1 text-muted tabular">{cards.length}</span>
              </p>
              <p className="text-xs text-muted">{col.hint}</p>
            </header>
            {cards.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-xs text-muted">{dragging && accepts(col.status) ? 'Drop here' : 'Nothing here'}</p>
            ) : (
              <ul className="stagger space-y-2">
                {cards.map((w) => {
                  const move = canEdit ? nextMove(w, canVerify) : null
                  const draggable = canEdit && w.status !== 'verified'
                  return (
                    <li
                      key={w.id}
                      draggable={draggable}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', w.id)
                        e.dataTransfer.effectAllowed = 'move'
                        setDragging(w.id)
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setOver(null)
                      }}
                      className={cn('rounded-xl border border-line bg-card p-3 shadow-card transition-opacity', draggable && 'cursor-grab active:cursor-grabbing', dragging === w.id && 'opacity-40')}
                    >
                      <div className="flex items-start gap-2">
                        {draggable && <GripVertical aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle" />}
                        <div className="min-w-0 flex-1">
                          <Link to={`/maintenance/work-orders/${w.id}`} className="block text-sm font-semibold hover:underline">
                            {w.title}
                          </Link>
                          <p className="mt-0.5 truncate text-xs text-muted">
                            <span className="font-mono">{w.unitCode || w.villaName}</span> · {w.vendorName || w.assigneeName || 'Unassigned'}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-1.5">
                            {w.priority !== 'normal' && <Tag tone={PRIORITY_TONE[w.priority]}>{PRIORITY_LABEL[w.priority]}</Tag>}
                            {w.status === 'on_hold' && <Tag tone="danger">On hold</Tag>}
                            {w.status === 'verified' && <Tag tone="success">Verified</Tag>}
                            {w.late && <Tag tone="accent">Late</Tag>}
                            {w.blockId && <Tag tone="neutral">Unit blocked</Tag>}
                            {w.scheduledOn && (w.status === 'scheduled' || w.status === 'open') && <span className="text-xs text-muted">{shortDay(w.scheduledOn)}</span>}
                            {w.total > 0 && <span className="ml-auto text-xs font-semibold tabular">{money(w.total)}</span>}
                          </div>
                        </div>
                      </div>
                      {move && (
                        <div className="mt-3 flex justify-end">
                          <Button size="sm" variant={move.to === 'done' || move.to === 'verified' ? 'solid' : 'soft'} loading={busy === w.id} onClick={() => onMove(w, move.to)}>
                            {busy !== w.id && move.to === 'done' && <Check aria-hidden className="size-3.5" />}
                            {busy !== w.id && move.to === 'in_progress' && <Play aria-hidden className="size-3.5" />}
                            {busy !== w.id && move.to === 'verified' && <ShieldCheck aria-hidden className="size-3.5" />}
                            {move.label}
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
