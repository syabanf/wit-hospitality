import { useState } from 'react'
import { Link } from 'react-router'
import type { WakeUpRow } from '@/application/frontDesk'
import { WAKE_UP_OUTCOME_LABEL, type WakeUpOutcome } from '@/domain/frontDesk'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'

const OUTCOMES: readonly WakeUpOutcome[] = ['done', 'no_answer', 'cancelled']

/** Pending wake-up calls by time, each with Done, No answer and Cancel; overdue calls stand out. */
export function WakeUpList({ rows, today, empty, onChanged, actions = true }: { rows: readonly WakeUpRow[]; today: string; empty: string; onChanged: () => void; actions?: boolean }) {
  const { frontDesk } = useServices()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  async function mark(r: WakeUpRow, outcome: WakeUpOutcome) {
    setBusy(`${r.bookingId}:${r.call.id}:${outcome}`)
    try {
      await frontDesk.wakeUpOutcome(r.bookingId, r.call.id, outcome)
      toast({ title: `Marked ${r.unitCode} ${WAKE_UP_OUTCOME_LABEL[outcome].toLowerCase()}`, description: outcome === 'no_answer' ? 'The call stays on the list for a retry.' : `${r.guestName}, ${r.call.time}` })
      onChanged()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not mark the call', description: fieldErrors(error).form })
    } finally {
      setBusy(null)
    }
  }

  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={`${r.bookingId}:${r.call.id}`} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel px-4 py-3 text-sm', r.overdue ? 'bg-danger-soft' : 'bg-raised')}>
          <span className="text-lg font-semibold tabular">{r.call.time}</span>
          <Link to={`/bookings/${r.bookingId}`} className="min-w-0 flex-1 hover:underline">
            <span className="block truncate font-medium">
              {r.unitCode} · {r.guestName}
            </span>
            <span className="block truncate text-xs text-muted">
              {r.code}
              {r.call.date < today && ` · missed on ${shortDay(r.call.date)}`}
              {r.call.repeatDaily && ' · daily'}
              {r.call.note && ` · ${r.call.note}`}
              {r.lastTry && ` · ${r.lastTry}`}
            </span>
          </Link>
          {r.overdue && <Tag tone="danger">Overdue</Tag>}
          {actions && (
            <span className="flex flex-wrap gap-2">
              {OUTCOMES.map((o) => (
                <Button key={o} size="sm" variant={o === 'done' ? 'solid' : 'soft'} loading={busy === `${r.bookingId}:${r.call.id}:${o}`} onClick={() => void mark(r, o)}>
                  {o === 'cancelled' ? 'Cancel' : WAKE_UP_OUTCOME_LABEL[o]}
                </Button>
              ))}
            </span>
          )}
          {!actions && <span className="text-xs text-muted">{shortDay(r.call.date)}</span>}
        </li>
      ))}
    </ul>
  )
}
