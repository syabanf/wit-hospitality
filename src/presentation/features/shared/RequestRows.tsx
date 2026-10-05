import { Link } from 'react-router'
import { Check, Play } from 'lucide-react'
import type { ServiceRequestView } from '@/application/views'
import { clockLabel, nextServiceStep, SERVICE_KIND_LABEL, SERVICE_STATUS_LABEL } from '@/domain/roomService'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { SERVICE_TONE } from './tones'

interface RequestRowsProps {
  requests: readonly ServiceRequestView[]
  empty: string
  /** Runs the next step (Start, Mark done) for a row. Leave out for a read-only list. */
  onAdvance?: (r: ServiceRequestView) => void
  busy?: string | null
  today?: string
}

/** Requests stacked as rows: kind, unit, guest, note, time, the next step as a button. */
export function RequestRows({ requests, empty, onAdvance, busy = null, today }: RequestRowsProps) {
  if (requests.length === 0) return <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {requests.map((r) => {
        const step = nextServiceStep(r)
        return (
          <li key={r.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <span className="w-11 shrink-0 text-xs text-muted tabular">{r.requestedOn === today ? clockLabel(r.requestedAt) : shortDay(r.requestedOn)}</span>
            <div className="min-w-0 flex-1">
              <Link to={`/services/${r.id}`} className="block truncate text-sm font-medium hover:underline">
                <span className="font-mono">{r.unitCode}</span> · {SERVICE_KIND_LABEL[r.kind]}
                {r.priority === 'urgent' && <Tag tone="accent" className="ml-2">Urgent</Tag>}
              </Link>
              <p className="truncate text-xs text-muted">
                {r.guestName ?? 'Housekeeping'}
                {r.note && ` · ${r.note}`}
                {r.charge > 0 && ` · ${money(r.charge)}`}
                {r.assignee && ` · ${r.assignee}`}
              </p>
            </div>
            {onAdvance && step ? (
              <Button size="sm" variant={step === 'done' ? 'solid' : 'soft'} loading={busy === r.id} onClick={() => onAdvance(r)}>
                {busy !== r.id && (step === 'done' ? <Check aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />)}
                {step === 'done' ? 'Done' : 'Start'}
              </Button>
            ) : (
              <StatusPill tone={SERVICE_TONE[r.status]}>{SERVICE_STATUS_LABEL[r.status]}</StatusPill>
            )}
          </li>
        )
      })}
    </ul>
  )
}
