import { useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import { Check, GripVertical, Play } from 'lucide-react'
import type { ServiceRequestView } from '@/application/views'
import { canTransitionService, clockLabel, nextServiceStep, SERVICE_KIND_LABEL, SERVICE_STATUS_LABEL, type ServiceStatus } from '@/domain/roomService'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'

const COLUMNS: ReadonlyArray<{ status: ServiceStatus; hint: string }> = [
  { status: 'open', hint: 'Waiting for someone' },
  { status: 'in_progress', hint: 'Being handled' },
  { status: 'done', hint: 'Closed' },
]

interface KanbanBoardProps {
  requests: readonly ServiceRequestView[]
  today: string
  busy: string | null
  /** Moves a request to a column; the caller runs the transition and reports failures. */
  onMove: (r: ServiceRequestView, to: Exclude<ServiceStatus, 'open'>) => void
}

/** Open, In progress and Done as columns. Drag a card across, or use its Start and Done buttons. */
export function KanbanBoard({ requests, today, busy, onMove }: KanbanBoardProps) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<ServiceStatus | null>(null)
  const cancelled = requests.filter((r) => r.status === 'cancelled')

  function drop(e: DragEvent, status: ServiceStatus) {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/plain') || dragging
    setOver(null)
    setDragging(null)
    const r = requests.find((x) => x.id === id)
    if (!r || r.status === status || status === 'open') return
    if (canTransitionService(r, status)) onMove(r, status)
  }

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {COLUMNS.map((col) => {
          const cards = requests.filter((r) => r.status === col.status)
          const target = dragging ? requests.find((r) => r.id === dragging) : null
          const accepts = target ? col.status !== 'open' && target.status !== col.status && canTransitionService(target, col.status) : false
          return (
            <section
              key={col.status}
              aria-label={SERVICE_STATUS_LABEL[col.status]}
              onDragOver={(e) => {
                if (!accepts) return
                e.preventDefault()
                setOver(col.status)
              }}
              onDragLeave={() => setOver((o) => (o === col.status ? null : o))}
              onDrop={(e) => drop(e, col.status)}
              className={cn('flex min-h-40 flex-col rounded-panel bg-raised p-3 transition-colors', over === col.status && accepts && 'ring-2 ring-accent', dragging && !accepts && col.status !== target?.status && 'opacity-60')}
            >
              <header className="mb-3 flex items-center justify-between px-1">
                <p className="text-sm font-semibold">
                  {SERVICE_STATUS_LABEL[col.status]} <span className="ml-1 text-muted tabular">{cards.length}</span>
                </p>
                <p className="text-xs text-muted">{col.hint}</p>
              </header>
              {cards.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-xs text-muted">{dragging && accepts ? 'Drop here' : 'Nothing here'}</p>
              ) : (
                <ul className="space-y-2">
                  {cards.map((r) => {
                    const step = nextServiceStep(r)
                    return (
                      <li
                        key={r.id}
                        draggable={r.status !== 'done'}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', r.id)
                          e.dataTransfer.effectAllowed = 'move'
                          setDragging(r.id)
                        }}
                        onDragEnd={() => {
                          setDragging(null)
                          setOver(null)
                        }}
                        className={cn('rounded-xl border border-line bg-card p-3 shadow-card transition-opacity', r.status !== 'done' && 'cursor-grab active:cursor-grabbing', dragging === r.id && 'opacity-40')}
                      >
                        <div className="flex items-start gap-2">
                          {r.status !== 'done' && <GripVertical aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle" />}
                          <div className="min-w-0 flex-1">
                            <Link to={`/services/${r.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold hover:underline">
                              <span className="font-mono">{r.unitCode}</span>
                              {SERVICE_KIND_LABEL[r.kind]}
                              {r.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}
                            </Link>
                            <p className="mt-0.5 text-xs text-muted">
                              {r.requestedOn === today ? clockLabel(r.requestedAt) : shortDay(r.requestedOn)} · {r.guestName ?? 'Housekeeping'}
                              {r.assignee && ` · ${r.assignee}`}
                            </p>
                            {r.note && <p className="mt-1 line-clamp-2 text-sm text-body">{r.note}</p>}
                            {r.charge > 0 && <p className="mt-1 text-xs font-semibold tabular">{money(r.charge)}</p>}
                          </div>
                        </div>
                        {step && (
                          <div className="mt-3 flex justify-end">
                            <Button size="sm" variant={step === 'done' ? 'solid' : 'soft'} loading={busy === r.id} onClick={() => onMove(r, step)}>
                              {busy !== r.id && (step === 'done' ? <Check aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />)}
                              {step === 'done' ? 'Mark done' : 'Start'}
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
      {cancelled.length > 0 && (
        <p className="text-xs text-muted">
          {cancelled.length} cancelled {cancelled.length === 1 ? 'request is' : 'requests are'} hidden from the board; switch to the table to see them.
        </p>
      )}
    </div>
  )
}
