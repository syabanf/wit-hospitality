import { useState } from 'react'
import { Link } from 'react-router'
import type { HousekeepingRow } from '@/application/views'
import { HOUSEKEEPING_ACTION, HOUSEKEEPING_LABEL, HOUSEKEEPING_STATES, nextHousekeeping, type HousekeepingState } from '@/domain/maintenance'
import { cn } from '@/lib/cn'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { fieldErrors } from '../../ui/fieldErrors'
import { Skeleton } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { InspectionForm } from '../maintenance/InspectionForm'
import { HOUSEKEEPING_TONE } from '../maintenance/tones'
import { Screen } from './Screen'

/** Rooms as stacked cards, arrivals first; one tap moves a room to its next state. */
export function HousekeepingScreen() {
  const { maintenance } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('maintenance.housekeeping', () => maintenance.housekeeping())
  const [filter, setFilter] = useState<HousekeepingState | 'todo'>('todo')
  const [busy, setBusy] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState<string | null>(null)
  const canEdit = can('maintenance', 'edit')

  async function move(r: HousekeepingRow, to: HousekeepingState) {
    setBusy(r.place.unit.id)
    try {
      const record = await maintenance.setHousekeeping(r.place.unit.id, to)
      // A release names the amenities the store was short of.
      toast({ title: `${r.place.unit.code} ${HOUSEKEEPING_LABEL[to].toLowerCase()}`, description: record.note || undefined })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not move ${r.place.unit.code}`, description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(null)
    }
  }

  const d = data.data
  const rows = d ? d.rows.filter((r) => (filter === 'todo' ? r.state !== 'ready' : r.state === filter)).sort((a, b) => Number(Boolean(b.arrival)) - Number(Boolean(a.arrival)) || HOUSEKEEPING_STATES.indexOf(a.state) - HOUSEKEEPING_STATES.indexOf(b.state)) : []

  return (
    <Screen title="Housekeeping" band="blue">
      <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
        {(['todo', ...HOUSEKEEPING_STATES] as const).map((s) => (
          <Button key={s} size="sm" variant={filter === s ? 'solid' : 'soft'} aria-pressed={filter === s} onClick={() => setFilter(s)}>
            {s === 'todo' ? 'To do' : HOUSEKEEPING_LABEL[s]}
            {d && <span className="tabular opacity-60">{s === 'todo' ? d.rows.filter((r) => r.state !== 'ready').length : d.rows.filter((r) => r.state === s).length}</span>}
          </Button>
        ))}
      </div>
      {!d ? (
        <Skeleton className="h-40 rounded-[22px]" />
      ) : rows.length === 0 ? (
        <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">Nothing here. Every room in this list is done.</p>
      ) : (
        <ul className="stagger space-y-2">
          {rows.map((r) => {
            const next = nextHousekeeping(r.state)
            return (
              <li key={r.place.unit.id} className={cn('rounded-[22px] bg-card p-3 shadow-card', r.arrival && r.state !== 'ready' && 'ring-2 ring-accent')}>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <span className="font-mono">{r.place.unit.code}</span>
                      {r.arrival && <Tag tone="accent">Arrival</Tag>}
                      {r.departure && <Tag tone="info">Leaves today</Tag>}
                    </p>
                    <p className="truncate text-xs text-muted">{r.arrival ? r.arrival.guestName : (r.blockingWorkOrder?.title ?? r.record?.note ?? r.place.villa.name)}</p>
                  </div>
                  <StatusPill tone={HOUSEKEEPING_TONE[r.state]}>{HOUSEKEEPING_LABEL[r.state]}</StatusPill>
                </div>
                {r.blockingWorkOrder && (
                  <Link to={`/maintenance/work-orders/${r.blockingWorkOrder.id}`} className="mt-2 block text-xs text-accent-text">
                    {r.blockingWorkOrder.number} holds the room
                  </Link>
                )}
                {canEdit && next && (
                  <div className="mt-3">
                    {next === 'inspected' && inspecting === r.place.unit.id ? (
                      <div className="animate-pop-in rounded-[18px] bg-raised p-3">
                        <InspectionForm
                          unitCode={r.place.unit.code}
                          save={(results, raise) => maintenance.inspect(r.place.unit.id, results, raise)}
                          onDone={(result) => {
                            setInspecting(null)
                            toast({ title: result.record.state === 'inspected' ? `${r.place.unit.code} passed` : `${r.place.unit.code} back to dirty`, description: result.workOrder ? `Opened ${result.workOrder.number}` : undefined })
                            data.reload()
                          }}
                        />
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant={next === 'ready' ? 'accent' : 'solid'}
                        className="w-full"
                        loading={busy === r.place.unit.id}
                        onClick={() => (next === 'inspected' ? setInspecting(r.place.unit.id) : void move(r, next))}
                      >
                        {HOUSEKEEPING_ACTION[next]}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Screen>
  )
}
