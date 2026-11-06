import { useState, type DragEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArrowRight, GripVertical, Search, Wrench } from 'lucide-react'
import type { HousekeepingRow } from '@/application/views'
import { canMoveHousekeeping, HOUSEKEEPING_ACTION, HOUSEKEEPING_LABEL, HOUSEKEEPING_STATES, nextHousekeeping, type HousekeepingState } from '@/domain/maintenance'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Popover } from '../../ui/Popover'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { useToast } from '../../ui/useToast'
import { Tabs } from '../../ui/Tabs'
import { AssignmentsTab } from '../housekeeping/AssignmentsTab'
import { LinenTab } from '../housekeeping/LinenTab'
import { InspectionForm } from './InspectionForm'

const HINT: Record<HousekeepingState, string> = { dirty: 'Waiting for the team', cleaning: 'Team in the room', inspected: 'Checked, not released', ready: 'Sellable and clean', out_of_order: 'Blocked by a job' }

type Tab = 'board' | 'assign' | 'linen'
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'board', label: 'Board' },
  { value: 'assign', label: 'Room attendants' },
  { value: 'linen', label: 'Linen and laundry' },
]

/** The board, the day's room attendant assignments, and linen with the laundry. */
export default function HousekeepingPage() {
  const [params, setParams] = useSearchParams()
  const tab = TABS.find((t) => t.value === params.get('tab'))?.value ?? 'board'
  return (
    <div className="space-y-4">
      <Tabs
        label="Housekeeping views"
        options={TABS}
        value={tab}
        onChange={(t) => {
          const search = new URLSearchParams(params)
          if (t === 'board') search.delete('tab')
          else search.set('tab', t)
          setParams(search, { replace: true })
        }}
        className="max-w-full overflow-x-auto"
      />
      {tab === 'board' ? <Board /> : tab === 'assign' ? <AssignmentsTab /> : <LinenTab />}
    </div>
  )
}

/** Rooms from dirty to ready; a check-out drops a room into Dirty. Drag a card or use its button. */
function Board() {
  const { maintenance } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('maintenance.housekeeping', () => maintenance.housekeeping())
  const [params, setParams] = useSearchParams()
  const [busy, setBusy] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<HousekeepingState | null>(null)
  const villa = params.get('villa') ?? ''
  const q = (params.get('q') ?? '').toLowerCase()
  const arrivalsOnly = params.get('arrivals') === '1'
  const canEdit = can('maintenance', 'edit')

  function update(next: Record<string, string>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    setParams(search, { replace: true })
  }

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

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const rows = d.rows.filter((r) => (!villa || r.place.villa.id === villa) && (!arrivalsOnly || r.arrival) && (!q || [r.place.unit.code, r.place.unit.name, r.arrival?.guestName ?? ''].some((v) => v.toLowerCase().includes(q))))
  const target = rows.find((r) => r.place.unit.id === dragging)
  const accepts = (to: HousekeepingState) => Boolean(canEdit && target && target.state !== to && to !== 'inspected' && to !== 'out_of_order' && canMoveHousekeeping(target.state, to))

  function drop(e: DragEvent, to: HousekeepingState) {
    e.preventDefault()
    setOver(null)
    setDragging(null)
    const r = rows.find((x) => x.place.unit.id === (e.dataTransfer.getData('text/plain') || dragging))
    if (r && accepts(to)) void move(r, to)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Check-out drops a room into Dirty. Clean it, inspect it against the checklist, then release it. Rooms with a guest arriving today are outlined in red.</p>
        <Link to="/maintenance" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
          Maintenance <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {HOUSEKEEPING_STATES.map((s) => (
          <StatTile key={s} label={HOUSEKEEPING_LABEL[s]} value={d.rows.filter((r) => r.state === s).length} hint={`${d.rows.filter((r) => r.state === s && r.arrival).length} with an arrival`} />
        ))}
      </div>
      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
          <div className="min-w-56 flex-1 basis-64">
            <Input className="h-10" icon={<Search className="size-4" />} placeholder="Unit or arriving guest" aria-label="Search rooms" value={params.get('q') ?? ''} onChange={(e) => update({ q: e.target.value })} />
          </div>
          <Select aria-label="Villa" value={villa} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => update({ villa: e.target.value })} />
          <Button size="sm" variant={arrivalsOnly ? 'solid' : 'soft'} aria-pressed={arrivalsOnly} onClick={() => update({ arrivals: arrivalsOnly ? '' : '1' })}>
            Arrivals today <span className="tabular opacity-70">{d.rows.filter((r) => r.arrival).length}</span>
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 xl:grid-cols-5">
          {HOUSEKEEPING_STATES.map((col) => {
            const cards = rows.filter((r) => r.state === col).sort((a, b) => Number(Boolean(b.arrival)) - Number(Boolean(a.arrival)) || a.place.unit.code.localeCompare(b.place.unit.code))
            return (
              <section
                key={col}
                aria-label={HOUSEKEEPING_LABEL[col]}
                onDragOver={(e) => {
                  if (!accepts(col)) return
                  e.preventDefault()
                  setOver(col)
                }}
                onDragLeave={() => setOver((o) => (o === col ? null : o))}
                onDrop={(e) => drop(e, col)}
                className={cn('flex min-h-40 min-w-0 flex-col rounded-panel bg-raised p-3 transition-colors', over === col && 'ring-2 ring-accent')}
              >
                <header className="mb-3 flex items-center justify-between gap-2 px-1">
                  <p className="text-sm font-semibold">
                    {HOUSEKEEPING_LABEL[col]} <span className="ml-1 text-muted tabular">{cards.length}</span>
                  </p>
                  <p className="truncate text-xs text-muted">{HINT[col]}</p>
                </header>
                {cards.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-xs text-muted">Nothing here</p>
                ) : (
                  <ul className="stagger space-y-2">
                    {cards.map((r) => {
                      const next = nextHousekeeping(r.state)
                      const draggable = canEdit && r.state !== 'out_of_order'
                      return (
                        <li
                          key={r.place.unit.id}
                          draggable={draggable}
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/plain', r.place.unit.id)
                            setDragging(r.place.unit.id)
                          }}
                          onDragEnd={() => {
                            setDragging(null)
                            setOver(null)
                          }}
                          className={cn('rounded-xl border bg-card p-3 shadow-card', r.arrival && r.state !== 'ready' ? 'border-accent ring-1 ring-accent' : 'border-line', draggable && 'cursor-grab', dragging === r.place.unit.id && 'opacity-40')}
                        >
                          <div className="flex items-start gap-2">
                            {draggable && <GripVertical aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle" />}
                            <div className="min-w-0 flex-1">
                              <Link to={`/property/units/${r.place.unit.id}`} className="font-mono text-sm font-semibold hover:underline">
                                {r.place.unit.code}
                              </Link>
                              <p className="truncate text-xs text-muted">{r.place.villa.name}</p>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {r.arrival && <Tag tone="accent">Arrives {r.arrival.checkIn < d.today ? 'late' : 'today'}</Tag>}
                                {r.departure && <Tag tone="info">Leaves today</Tag>}
                                {r.inHouse && !r.departure && <Tag tone="neutral">Guest in house</Tag>}
                              </div>
                              {r.arrival && <p className="mt-1.5 truncate text-xs text-body">{r.arrival.guestName}</p>}
                              {r.blockingWorkOrder ? (
                                <Link to={`/maintenance/work-orders/${r.blockingWorkOrder.id}`} className="mt-1.5 flex items-center gap-1 text-xs text-accent-text hover:underline">
                                  <Wrench aria-hidden className="size-3" /> {r.blockingWorkOrder.number}
                                </Link>
                              ) : (
                                r.record?.note && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{r.record.note}</p>
                              )}
                              {r.record && r.state !== 'ready' && <p className="mt-1 text-[11px] text-subtle">{r.record.updatedBy}, {shortDay(r.record.updatedOn)}</p>}
                            </div>
                          </div>
                          {canEdit && next && (
                            <div className="mt-3 flex justify-end">
                              {next === 'inspected' ? (
                                <Popover
                                  align="right"
                                  className="w-80 animate-pop-in p-4"
                                  trigger={(props) => (
                                    <Button {...props} size="sm" variant="solid">
                                      {HOUSEKEEPING_ACTION.inspected}
                                    </Button>
                                  )}
                                >
                                  {(close) => (
                                    <InspectionForm
                                      unitCode={r.place.unit.code}
                                      save={(results, raise) => maintenance.inspect(r.place.unit.id, results, raise)}
                                      onDone={(result) => {
                                        close()
                                        toast({ title: result.record.state === 'inspected' ? `${r.place.unit.code} passed` : `${r.place.unit.code} back to dirty`, description: result.workOrder ? `Opened ${result.workOrder.number}` : undefined })
                                        data.reload()
                                      }}
                                    />
                                  )}
                                </Popover>
                              ) : (
                                <Button size="sm" variant={next === 'ready' ? 'accent' : 'soft'} loading={busy === r.place.unit.id} onClick={() => void move(r, next)}>
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
              </section>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
