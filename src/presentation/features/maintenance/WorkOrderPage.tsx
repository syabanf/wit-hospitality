import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Ban, CalendarClock, Check, CircleDollarSign, Lock, Paperclip, Pause, Pencil, Play, ShieldCheck, Unlock } from 'lucide-react'
import { canTransitionWorkOrder, isOpenWorkOrder, MAINTENANCE_CATEGORY_LABEL, PRIORITY_LABEL, WORK_ORDER_ACTION_LABEL, WORK_ORDER_SOURCE_LABEL, WORK_ORDER_STATUS_LABEL, type WorkOrderEvent, type WorkOrderStatus } from '@/domain/maintenance'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { addDays, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Input } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { Popover } from '../../ui/Popover'
import { Steps } from '../../ui/Steps'
import { useToast } from '../../ui/useToast'
import { TRANSACTION_TONE } from '../shared/tones'
import { PRIORITY_TONE, WORK_ORDER_TONE } from './tones'
import { WorkOrderForm } from './WorkOrderForm'

type Move = Exclude<WorkOrderStatus, 'open'>
const ICON: Record<Move, typeof Play> = { scheduled: CalendarClock, in_progress: Play, on_hold: Pause, done: Check, verified: ShieldCheck, cancelled: Ban }
const NEEDS_NOTE: readonly Move[] = ['on_hold', 'cancelled']
const EVENT_LABEL: Record<WorkOrderEvent['kind'], string> = { ...WORK_ORDER_STATUS_LABEL, created: 'Reported', note: 'Note', blocked: 'Unit blocked', unblocked: 'Block released', cost: 'Cost recorded' }

/** One job: lifecycle, who and what, parts and costs, photos, the unit block, the cash entry and the history. */
export default function WorkOrderPage() {
  const { id = '' } = useParams()
  const { maintenance } = useServices()
  const toast = useToast()
  const resource = useResource(`maintenance.workOrder:${id}`, () => maintenance.workOrder(id), { keepPrevious: false })
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(key: string, label: string, action: () => Promise<unknown>) {
    setBusy(key)
    setErrors({})
    try {
      await action()
      toast({ title: label })
      resource.reload()
      return true
    } catch (error) {
      const e = fieldErrors(error)
      setErrors(e)
      toast({ tone: 'danger', title: `Could not ${label.toLowerCase()}`, description: Object.values(e)[0] })
      return false
    } finally {
      setBusy(null)
    }
  }

  return (
    <Gate resource={resource} what="work order" back={{ to: '/maintenance/work-orders', label: 'Back to work orders' }}>
      {(d) => {
        const w = d.workOrder
        const moves = (['scheduled', 'in_progress', 'on_hold', 'done', 'verified', 'cancelled'] as Move[]).filter((to) => canTransitionWorkOrder(w, to) && (to === 'verified' ? d.canVerify : d.canEdit))
        const primary = moves.find((m) => m !== 'cancelled' && m !== 'on_hold' && m !== 'scheduled')
        const secondary = moves.filter((m) => m !== primary)
        const step = (to: Move, note = '') => run(to, `${WORK_ORDER_ACTION_LABEL[to]} ${w.number}`, () => maintenance.transition(w.id, to, note))
        return (
          <>
            <PageBar
              fallback="/maintenance/work-orders"
              label="Work orders"
              actions={
                <>
                  {d.canEdit && w.status !== 'verified' && w.status !== 'cancelled' && (
                    <Button variant="card" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                      <Pencil aria-hidden className="size-4" /> Edit
                    </Button>
                  )}
                  {d.canEdit && w.unitId && isOpenWorkOrder(w) && w.blockId && (
                    <Button variant="card" loading={busy === 'unblock'} onClick={() => void run('unblock', `Released ${w.unitCode}`, () => maintenance.setBlock(w.id, null, null))}>
                      <Unlock aria-hidden className="size-4" /> Release unit
                    </Button>
                  )}
                  {d.canEdit && w.unitId && isOpenWorkOrder(w) && !w.blockId && (
                    <Popover
                      align="right"
                      className="w-80 animate-pop-in p-4"
                      trigger={(props) => (
                        <Button {...props} variant="card">
                          <Lock aria-hidden className="size-4" /> Block unit
                        </Button>
                      )}
                    >
                      {(close) => (
                        <form
                          className="space-y-3"
                          onSubmit={(e: FormEvent<HTMLFormElement>) => {
                            e.preventDefault()
                            const f = new FormData(e.currentTarget)
                            void run('block', `Blocked ${w.unitCode}`, () => maintenance.setBlock(w.id, String(f.get('from')), String(f.get('to')))).then((ok) => ok && close())
                          }}
                        >
                          <p className="text-sm">Stop selling {w.unitCode} while the job runs. Booked guests on those nights refuse the block.</p>
                          <div className="grid grid-cols-2 gap-2">
                            <Field label="From" htmlFor="blk-from">
                              <Input id="blk-from" name="from" type="date" defaultValue={d.today} className="px-3" />
                            </Field>
                            <Field label="Until" htmlFor="blk-to" error={errors.to}>
                              <Input id="blk-to" name="to" type="date" defaultValue={addDays(d.today, 2)} className="px-3" />
                            </Field>
                          </div>
                          {errors.form && <p className="text-xs font-medium text-danger">{errors.form}</p>}
                          <Button type="submit" size="sm" variant="solid" loading={busy === 'block'}>
                            Block {w.unitCode}
                          </Button>
                        </form>
                      )}
                    </Popover>
                  )}
                  {secondary.map((to) => {
                    const Icon = ICON[to]
                    if (!NEEDS_NOTE.includes(to)) {
                      return (
                        <Button key={to} variant="card" loading={busy === to} onClick={() => void step(to)}>
                          <Icon aria-hidden className="size-4" /> {WORK_ORDER_ACTION_LABEL[to]}
                        </Button>
                      )
                    }
                    return (
                      <Popover
                        key={to}
                        align="right"
                        className="w-80 animate-pop-in p-4"
                        trigger={(props) => (
                          <Button {...props} variant="card">
                            <Icon aria-hidden className="size-4" /> {WORK_ORDER_ACTION_LABEL[to]}
                          </Button>
                        )}
                      >
                        {(close) => (
                          <form
                            className="space-y-3"
                            onSubmit={(e: FormEvent<HTMLFormElement>) => {
                              e.preventDefault()
                              void step(to, String(new FormData(e.currentTarget).get('note') ?? '')).then((ok) => ok && close())
                            }}
                          >
                            <Field label="Why" htmlFor={`note-${to}`} error={errors.note ?? errors.form}>
                              <Input id={`note-${to}`} name="note" placeholder={to === 'on_hold' ? 'Waiting for parts' : 'Fixed by housekeeping'} />
                            </Field>
                            <Button type="submit" size="sm" variant="solid" loading={busy === to}>
                              {WORK_ORDER_ACTION_LABEL[to]}
                            </Button>
                          </form>
                        )}
                      </Popover>
                    )
                  })}
                  {d.canRecordCost && (
                    <Button variant="card" loading={busy === 'cost'} onClick={() => void run('cost', `Recorded the cost of ${w.number}`, () => maintenance.recordCost(w.id))}>
                      <CircleDollarSign aria-hidden className="size-4" /> Record cost
                    </Button>
                  )}
                  {primary &&
                    (() => {
                      const Icon = ICON[primary]
                      return (
                        <Button variant="accent" loading={busy === primary} onClick={() => void step(primary)}>
                          <Icon aria-hidden className="size-4" /> {WORK_ORDER_ACTION_LABEL[primary]}
                        </Button>
                      )
                    })()}
                </>
              }
            />
            {editing ? (
              <div className="animate-rise">
                <WorkOrderForm
                  initial={w}
                  options={d}
                  save={(input) => maintenance.updateWorkOrder(w.id, input)}
                  onDone={() => {
                    toast({ title: `Saved ${w.number}` })
                    setEditing(false)
                    resource.reload()
                  }}
                  onCancel={() => setEditing(false)}
                />
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
                <div className="stagger min-w-0 space-y-4">
                  <Card aria-label={`Work order ${w.number}`}>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-muted">
                          {w.number} · {WORK_ORDER_SOURCE_LABEL[w.source]}
                        </p>
                        <Headline className="mt-1">{w.title}</Headline>
                        <p className="mt-1 text-sm text-muted">
                          {w.unitId ? (
                            <Link to={`/property/units/${w.unitId}`} className="font-mono hover:underline">
                              {w.unitCode}
                            </Link>
                          ) : (
                            'Shared'
                          )}{' '}
                          · {w.villaName}, {w.locationName}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <StatusPill tone={WORK_ORDER_TONE[w.status]}>{WORK_ORDER_STATUS_LABEL[w.status]}</StatusPill>
                        <Tag tone={PRIORITY_TONE[w.priority]}>{PRIORITY_LABEL[w.priority]}</Tag>
                      </div>
                    </div>
                    {w.description && <p className="mt-4 text-sm text-body">{w.description}</p>}
                    {w.late && <p className="mt-4 rounded-panel bg-accent-soft p-3 text-sm text-accent-text">Scheduled for {shortDay(w.scheduledOn ?? d.today)} and still open.</p>}
                    <FactGrid
                      className="mt-5 grid-cols-2 sm:grid-cols-3"
                      facts={[
                        ['Category', MAINTENANCE_CATEGORY_LABEL[w.category]],
                        ['Asset', d.asset ? <Link key="a" to={`/maintenance/assets/${d.asset.id}`} className="hover:underline">{d.asset.code}</Link> : 'None'],
                        ['Technician', w.assigneeName || 'Nobody yet'],
                        ['Vendor', w.vendorId ? <Link key="v" to={`/maintenance/vendors/${w.vendorId}`} className="hover:underline">{w.vendorName}</Link> : 'In-house'],
                        ['Reported by', `${w.reportedBy}, ${shortDay(w.createdOn)}`],
                        ['Scheduled', w.scheduledOn ? shortDay(w.scheduledOn) : 'Not set'],
                      ]}
                    />
                  </Card>
                  <Card aria-labelledby="wo-cost">
                    <CardHeader id="wo-cost" title="Parts and cost" action={<span className="text-lg font-semibold tabular">{money(w.total)}</span>} />
                    {w.parts.length > 0 ? (
                      <DataTable
                        label="Parts"
                        rows={w.parts.map((p, i) => ({ ...p, key: String(i) }))}
                        rowKey={(p) => p.key}
                        columns={[
                          { key: 'n', header: 'Part', cell: (p) => p.name },
                          { key: 'q', header: 'Qty', align: 'right', cell: (p) => p.qty },
                          { key: 'u', header: 'Unit cost', align: 'right', cell: (p) => money(p.unitCost) },
                          { key: 't', header: 'Total', align: 'right', cell: (p) => money(p.qty * p.unitCost) },
                        ]}
                        footer={['Parts', '', '', money(w.partsTotal)]}
                      />
                    ) : (
                      <p className="text-sm text-muted">No parts used.</p>
                    )}
                    <FactGrid className="mt-4 grid-cols-3" facts={[['Parts', money(w.partsTotal)], ['Labour', money(w.labourCost)], ['Vendor', money(w.vendorCost)]]} />
                    {d.transaction && (
                      <Link to={`/finance/transactions/${d.transaction.id}`} className="mt-4 flex flex-wrap items-center gap-3 rounded-panel bg-raised px-4 py-3 text-sm transition-colors hover:bg-control">
                        <span className="font-mono">{d.transaction.number}</span>
                        <span className="min-w-0 flex-1 truncate">{d.transaction.description}</span>
                        <StatusPill tone={TRANSACTION_TONE[d.transaction.status]}>{TRANSACTION_STATUS_LABEL[d.transaction.status]}</StatusPill>
                      </Link>
                    )}
                    {errors.cost && <p className="mt-3 text-xs font-medium text-danger">{errors.cost}</p>}
                  </Card>
                  {(w.beforePhotos.length > 0 || w.afterPhotos.length > 0) && (
                    <Card aria-labelledby="wo-photos-v">
                      <CardHeader id="wo-photos-v" title="Photos" />
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {(
                          [
                            ['Before', w.beforePhotos],
                            ['After', w.afterPhotos],
                          ] as const
                        ).map(([label, names]) => (
                          <div key={label}>
                            <p className="mb-2 text-xs font-medium text-muted">{label}</p>
                            {names.length === 0 ? (
                              <p className="text-sm text-muted">None</p>
                            ) : (
                              <ul className="space-y-1.5">
                                {names.map((n) => (
                                  <li key={n} className="flex items-center gap-2 text-sm">
                                    <Paperclip aria-hidden className="size-3.5 text-muted" />
                                    <span className="truncate">{n}</span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    </Card>
                  )}
                  <Card aria-labelledby="wo-history">
                    <CardHeader id="wo-history" title="History" />
                    <ol className="space-y-3">
                      {[...w.history].reverse().map((e, i) => (
                        <li key={i} className="flex gap-3 text-sm">
                          <span className="w-14 shrink-0 text-xs text-muted">{shortDay(e.on)}</span>
                          <span className="min-w-0 flex-1">
                            <span className="font-medium">{EVENT_LABEL[e.kind]}</span> <span className="text-muted">by {e.by}</span>
                            {e.note && <span className="block text-body">{e.note}</span>}
                          </span>
                        </li>
                      ))}
                    </ol>
                    {d.canEdit && (
                      <form
                        className="mt-4 flex flex-wrap items-end gap-2 border-t border-line pt-4"
                        onSubmit={(e: FormEvent<HTMLFormElement>) => {
                          e.preventDefault()
                          const form = e.currentTarget
                          const note = String(new FormData(form).get('note') ?? '')
                          void run('note', 'Added the note', () => maintenance.addNote(w.id, note)).then((ok) => ok && form.reset())
                        }}
                      >
                        <Field label="Add a note" htmlFor="wo-note" error={errors.note} className="min-w-56 flex-1">
                          <Textarea id="wo-note" name="note" rows={2} placeholder="Parts ordered, ETA Thursday" />
                        </Field>
                        <Button type="submit" variant="solid" loading={busy === 'note'}>
                          Add note
                        </Button>
                      </form>
                    )}
                  </Card>
                </div>
                <div className="space-y-4">
                  <Card aria-labelledby="wo-steps">
                    <CardHeader id="wo-steps" title="Lifecycle" />
                    <Steps label="Work order lifecycle" steps={d.steps} />
                  </Card>
                  <Card aria-labelledby="wo-blk">
                    <CardHeader id="wo-blk" title="Unit block" />
                    {d.block ? (
                      <p className="text-sm text-body">
                        {w.unitCode} is not for sale from {shortDay(d.block.from)} to {shortDay(d.block.to)}. Closing the job frees the nights still ahead.
                      </p>
                    ) : (
                      <p className="text-sm text-muted">{w.unitId ? 'The unit stays on sale.' : 'Shared equipment; no unit to block.'}</p>
                    )}
                  </Card>
                  {d.plan && (
                    <Card aria-labelledby="wo-plan">
                      <CardHeader id="wo-plan" title="Preventive plan" />
                      <Link to="/maintenance/preventive" className="block text-sm font-medium hover:underline">
                        {d.plan.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted">Next due {shortDay(d.plan.nextDue)}; finishing this job moves it forward.</p>
                      {d.plan.checklist.length > 0 && (
                        <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-body">
                          {d.plan.checklist.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                        </ul>
                      )}
                    </Card>
                  )}
                </div>
              </div>
            )}
          </>
        )
      }}
    </Gate>
  )
}
