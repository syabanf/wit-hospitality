import { useState } from 'react'
import { Link } from 'react-router'
import { Check, Play, Plus } from 'lucide-react'
import type { WorkOrderView } from '@/application/views'
import { PRIORITY_LABEL, WORK_ORDER_STATUS_LABEL, type WorkOrderStatus } from '@/domain/maintenance'
import { shortDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { fieldErrors } from '../../ui/fieldErrors'
import { Skeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { PRIORITY_TONE, WORK_ORDER_TONE } from '../maintenance/tones'
import { Screen } from './Screen'

const step = (w: WorkOrderView): { to: Exclude<WorkOrderStatus, 'open'>; label: string } | null => {
  if (w.status === 'open' || w.status === 'scheduled' || w.status === 'on_hold') return { to: 'in_progress', label: w.status === 'on_hold' ? 'Resume' : 'Start' }
  if (w.status === 'in_progress') return { to: 'done', label: 'Mark done' }
  return null
}

function JobCard({ w, busy, onStep }: { w: WorkOrderView; busy: boolean; onStep?: () => void }) {
  const next = step(w)
  return (
    <li className="rounded-[22px] bg-card p-3 shadow-card">
      <Link to={`/maintenance/work-orders/${w.id}`} className="block">
        <p className="text-sm font-semibold">{w.title}</p>
        <p className="mt-0.5 truncate text-xs text-muted">
          <span className="font-mono">{w.unitCode || w.villaName}</span> · {w.scheduledOn ? `due ${shortDay(w.scheduledOn)}` : `reported ${shortDay(w.createdOn)}`}
        </p>
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusPill tone={WORK_ORDER_TONE[w.status]}>{WORK_ORDER_STATUS_LABEL[w.status]}</StatusPill>
        {w.priority !== 'normal' && <Tag tone={PRIORITY_TONE[w.priority]}>{PRIORITY_LABEL[w.priority]}</Tag>}
        {onStep && next && (
          <Button size="sm" variant={next.to === 'done' ? 'solid' : 'soft'} className="ml-auto" loading={busy} onClick={onStep}>
            {!busy && (next.to === 'done' ? <Check aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />)}
            {next.label}
          </Button>
        )}
      </div>
    </li>
  )
}

/** The technician's list: my jobs first with one-tap start and done, then the rest of the open work. */
export function WorkOrdersScreen() {
  const { maintenance } = useServices()
  const toast = useToast()
  const data = useResource('maintenance.myWork', () => maintenance.myWork())
  const [busy, setBusy] = useState<string | null>(null)

  async function advance(w: WorkOrderView) {
    const next = step(w)
    if (!next) return
    setBusy(w.id)
    try {
      await maintenance.transition(w.id, next.to)
      toast({ title: `${w.number} ${WORK_ORDER_STATUS_LABEL[next.to].toLowerCase()}` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not update ${w.number}`, description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(null)
    }
  }

  const d = data.data
  return (
    <Screen
      title="Work orders"
      band="red"
      actions={
        <Link to="/maintenance/work-orders/new" aria-label="Report a fault" className={buttonStyles({ variant: 'onPop', size: 'icon', className: 'size-9' })}>
          <Plus aria-hidden className="size-4" />
        </Link>
      }
    >
      {!d ? (
        <Skeleton className="h-40 rounded-[22px]" />
      ) : (
        <>
          <section aria-labelledby="m-mine">
            <h2 id="m-mine" className="mb-2 text-base font-semibold">
              My jobs <span className="text-muted tabular">{d.mine.length}</span>
            </h2>
            {d.mine.length === 0 ? (
              <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">Nothing assigned to you.</p>
            ) : (
              <ul className="stagger space-y-2">
                {d.mine.map((w) => (
                  <JobCard key={w.id} w={w} busy={busy === w.id} onStep={d.canEdit ? () => void advance(w) : undefined} />
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="m-open">
            <h2 id="m-open" className="mb-2 text-base font-semibold">
              Open across the villas <span className="text-muted tabular">{d.others.length}</span>
            </h2>
            <ul className="stagger space-y-2">
              {d.others.map((w) => (
                <JobCard key={w.id} w={w} busy={busy === w.id} onStep={d.canEdit ? () => void advance(w) : undefined} />
              ))}
            </ul>
          </section>
        </>
      )}
    </Screen>
  )
}
