import { Fragment, useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import { AlertTriangle, CalendarPlus, GripVertical, Plus, Settings2, Wand2, Wrench } from 'lucide-react'
import type { AttendantView, TaskView } from '@/application/housekeeping'
import { isOpenTask, TASK_STATUS_LABEL, TASK_TYPE_LABEL, TASK_TYPES, type HousekeepingSettings, type TaskType } from '@/domain/housekeeping'
import { HOUSEKEEPING_LABEL } from '@/domain/maintenance'
import { cn } from '@/lib/cn'
import { fullDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Switch } from '../../ui/Switch'
import { useToast } from '../../ui/useToast'
import { WindowTag } from '../shared/WindowTag'
import { TASK_TONE } from './tones'

const UNASSIGNED = 'none'

/** The supervisor's day: tasks per room attendant, auto-assign, drag to reassign, quota and do-not-disturb flags. */
export function AssignmentsTab() {
  const { housekeeping, clock } = useServices()
  const toast = useToast()
  const [date, setDate] = useState(clock.today())
  const data = useResource(`housekeeping.day:${date}`, () => housekeeping.day(date))
  const [busy, setBusy] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [panel, setPanel] = useState<'add' | 'settings' | null>(null)

  async function act(key: string, run: () => Promise<string>) {
    setBusy(key)
    try {
      toast({ title: await run() })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not save', description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const assign = (t: TaskView, to: string) =>
    act(t.id, async () => {
      await housekeeping.assign([t.id], to === UNASSIGNED ? null : to)
      return to === UNASSIGNED ? `${t.unitCode} back to unassigned` : `${t.unitCode} to ${d.attendants.find((a) => a.id === to)?.name ?? 'the attendant'}`
    })
  // A hotel's rooms list under their floor, a villa's under the villa, in the same order in every column.
  const groupOf = new Map(d.groups.flatMap((g, i) => g.items.map((t) => [t.id, { label: g.label, rank: i }] as const)))
  const inGroups = (list: TaskView[]) => [...list].sort((x, y) => (groupOf.get(x.id)?.rank ?? 0) - (groupOf.get(y.id)?.rank ?? 0))
  const columns: Array<{ id: string; attendant: AttendantView | null; tasks: TaskView[] }> = [
    { id: UNASSIGNED, attendant: null, tasks: inGroups(d.tasks.filter((t) => !t.attendantId || !d.attendants.some((a) => a.id === t.attendantId))) },
    ...d.attendants.map((a) => ({ id: a.id, attendant: a, tasks: inGroups(d.tasks.filter((t) => t.attendantId === a.id)) })),
  ]
  const assignSection = (id: string, name: string, attendantId: string | null) =>
    act(`sec-${id}`, async () => {
      const moved = await housekeeping.assignSection(id, date, attendantId)
      return attendantId ? `${name} to ${d.attendants.find((a) => a.id === attendantId)?.name ?? 'the attendant'}, ${moved.length} tasks` : `${name} cleared, ${moved.length} tasks back to unassigned`
    })
  const moving = d.tasks.find((t) => t.id === dragging)
  const accepts = (column: string) => Boolean(d.canSupervise && moving && isOpenTask(moving) && (moving.attendantId ?? UNASSIGNED) !== column)
  const options = [{ value: UNASSIGNED, label: 'Unassigned' }, ...d.attendants.map((a) => ({ value: a.id, label: a.name }))]

  function drop(e: DragEvent, column: string) {
    e.preventDefault()
    setOver(null)
    setDragging(null)
    const t = d.tasks.find((x) => x.id === (e.dataTransfer.getData('text/plain') || dragging))
    if (t && accepts(column)) void assign(t, column)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" aria-label="Day" className="h-10 w-44" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <p className="text-sm text-muted">{fullDay(date)}</p>
        </div>
        {d.canSupervise && (
          <div className="flex flex-wrap gap-2">
            <Button variant="card" loading={busy === 'plan'} onClick={() => void act('plan', async () => `Planned ${(await housekeeping.planDay(date)).length} new tasks`)}>
              <CalendarPlus aria-hidden className="size-4" /> Plan the day
            </Button>
            <Button variant="accent" loading={busy === 'auto'} onClick={() => void act('auto', async () => `Assigned ${(await housekeeping.autoAssign(date)).length} tasks`)}>
              <Wand2 aria-hidden className="size-4" /> Auto-assign
            </Button>
            <Button variant="card" aria-pressed={panel === 'add'} onClick={() => setPanel(panel === 'add' ? null : 'add')}>
              <Plus aria-hidden className="size-4" /> Task
            </Button>
            <Button variant="card" aria-pressed={panel === 'settings'} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}>
              <Settings2 aria-hidden className="size-4" /> Quota and standards
            </Button>
          </div>
        )}
      </div>

      {panel === 'add' && <AddTaskForm date={date} units={d.catalog.units.filter((u) => u.status !== 'inactive')} attendants={d.attendants} onDone={() => (setPanel(null), data.reload())} />}
      {panel === 'settings' && <SettingsForm initial={d.settings} onDone={() => (setPanel(null), data.reload())} />}

      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Tasks" value={d.tasks.filter((t) => t.status !== 'cancelled').length} hint={`${d.tasks.filter((t) => t.status === 'done').length} done`} />
        <StatTile label="Unassigned" value={d.unassigned} hint={d.unassigned ? 'Give them out or add a shift' : 'Every task has an attendant'} />
        <StatTile label="Over quota" value={d.overQuota} hint={`Quota ${d.settings.dailyQuota} credits`} />
        <StatTile label="Attendants on shift" value={d.attendants.length} hint="From the roster" />
      </div>

      {d.dnd.length > 0 && (
        <Card className="flex items-start gap-3 bg-warning-soft">
          <AlertTriangle aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="text-sm">
            <p className="font-semibold">Do not disturb for {d.dnd[0]?.days} days or more</p>
            <ul className="mt-1 space-y-0.5 text-body">
              {d.dnd.map((a) => (
                <li key={a.bookingId}>
                  <Link to={`/bookings/${a.bookingId}`} className="font-mono hover:underline">
                    {a.unitCode}
                  </Link>{' '}
                  {a.guestName}, {a.days} days running. Check on the guest.
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      {d.sections.length > 0 && <SectionsCard date={date} sections={d.sections} attendants={d.attendants} canSupervise={d.canSupervise} busy={busy} onAssign={(id, name, attendantId) => void assignSection(id, name, attendantId)} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {columns.map((col) => {
          const a = col.attendant
          return (
            <section
              key={col.id}
              aria-label={a ? a.name : 'Unassigned'}
              onDragOver={(e) => {
                if (!accepts(col.id)) return
                e.preventDefault()
                setOver(col.id)
              }}
              onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
              onDrop={(e) => drop(e, col.id)}
              className={cn('flex min-h-40 min-w-0 flex-col rounded-panel bg-raised p-3 transition-colors', over === col.id && 'ring-2 ring-accent')}
            >
              <header className="mb-3 px-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">{a ? a.name : 'Unassigned'}</p>
                  {a ? (
                    <Tag tone={a.over ? 'danger' : 'neutral'}>
                      {a.credits} / {d.settings.dailyQuota}
                    </Tag>
                  ) : (
                    col.tasks.some(isOpenTask) && <Tag tone="accent">{col.tasks.filter(isOpenTask).length} open</Tag>
                  )}
                </div>
                <p className="truncate text-xs text-muted">{a ? `${a.shiftName} · ${a.villaNames}` : 'Drag a card onto an attendant'}</p>
              </header>
              {col.tasks.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line-strong px-3 py-6 text-center text-xs text-muted">Nothing here</p>
              ) : (
                <ul className="stagger space-y-2">
                  {col.tasks.map((t, i) => {
                    const draggable = d.canSupervise && isOpenTask(t)
                    const group = groupOf.get(t.id)?.label ?? ''
                    const heading = group !== (groupOf.get(col.tasks[i - 1]?.id ?? '')?.label ?? null) ? group : ''
                    return (
                      <Fragment key={t.id}>
                      {heading && <li className="px-1 pt-1 text-xs font-semibold tracking-wide text-muted uppercase">{heading}</li>}
                      <li
                        draggable={draggable}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('text/plain', t.id)
                          setDragging(t.id)
                        }}
                        onDragEnd={() => {
                          setDragging(null)
                          setOver(null)
                        }}
                        className={cn('rounded-xl border border-line bg-card p-3 shadow-card', draggable && 'cursor-grab', dragging === t.id && 'opacity-40')}
                      >
                        <div className="flex items-start gap-2">
                          {draggable && <GripVertical aria-hidden className="mt-0.5 size-4 shrink-0 text-subtle" />}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <Link to={`/property/units/${t.unitId}`} className="font-mono text-sm font-semibold hover:underline">
                                {t.unitCode}
                              </Link>
                              <StatusPill tone={TASK_TONE[t.status]}>{TASK_STATUS_LABEL[t.status]}</StatusPill>
                            </div>
                            <p className="truncate text-xs text-muted">
                              {TASK_TYPE_LABEL[t.type]} · {t.credits} cr · {t.villaName}
                            </p>
                            {t.guestName && <p className="mt-1 truncate text-xs text-body">{t.guestName}</p>}
                            <div className="mt-1.5 flex flex-wrap gap-1.5">
                              {t.boardState && t.type === 'departure' && <Tag tone="neutral">Board: {HOUSEKEEPING_LABEL[t.boardState]}</Tag>}
                              {t.serviceWindow && <WindowTag window={t.serviceWindow} />}
                              {(t.status === 'done' || t.runningSince) && (
                                <Tag tone={t.minutes > t.standardMinutes ? 'warning' : 'success'}>
                                  {t.minutes} of {t.standardMinutes} min
                                </Tag>
                              )}
                              {t.lostFound.length > 0 && <Tag tone="info">Found {t.lostFound.length}</Tag>}
                            </div>
                            {t.workOrders.map((w) => (
                              <Link key={w.id} to={`/maintenance/work-orders/${w.id}`} className="mt-1.5 flex items-center gap-1 text-xs text-accent-text hover:underline">
                                <Wrench aria-hidden className="size-3" /> {w.number}
                              </Link>
                            ))}
                            {t.note && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{t.note}</p>}
                            {draggable && <Select compact aria-label={`Attendant for ${t.unitCode}`} className="mt-2 w-full" value={t.attendantId ?? UNASSIGNED} options={options} disabled={busy === t.id} onChange={(e) => void assign(t, e.target.value)} />}
                          </div>
                        </div>
                      </li>
                      </Fragment>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

type SectionRow = Awaited<ReturnType<ReturnType<typeof useServices>['housekeeping']['day']>>['sections'][number]

/** Sections of hotel rooms: one attendant per section for the day; their pending tasks follow. */
function SectionsCard({ date, sections, attendants, canSupervise, busy, onAssign }: { date: string; sections: readonly SectionRow[]; attendants: readonly AttendantView[]; canSupervise: boolean; busy: string | null; onAssign: (id: string, name: string, attendantId: string | null) => void }) {
  return (
    <Card aria-labelledby="hk-sections">
      <CardHeader id="hk-sections" title="Sections" action={<span className="text-xs text-muted">{fullDay(date)}</span>} />
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
        {sections.map((x) => (
          <li key={x.id} className="flex flex-col gap-2 rounded-panel bg-raised p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-semibold">{x.name}</span>
              <Tag tone="neutral">{x.tasks} tasks</Tag>
            </div>
            <p className="truncate text-xs text-muted">
              {x.villaName} · <span className="font-mono">{x.unitCodes.join(', ')}</span>
            </p>
            {canSupervise ? (
              <Select compact aria-label={`Attendant for ${x.name}`} className="w-full" value={x.attendantId ?? UNASSIGNED} disabled={busy === `sec-${x.id}`} options={[{ value: UNASSIGNED, label: 'No attendant' }, ...attendants.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => onAssign(x.id, x.name, e.target.value === UNASSIGNED ? null : e.target.value)} />
            ) : (
              <p className="text-xs text-body">{x.attendantName || 'No attendant'}</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}

function AddTaskForm({ date, units, attendants, onDone }: { date: string; units: ReadonlyArray<{ id: string; code: string }>; attendants: readonly AttendantView[]; onDone: () => void }) {
  const { housekeeping } = useServices()
  const toast = useToast()
  const [form, setForm] = useState({ unitId: units[0]?.id ?? '', type: 'deep' as TaskType, attendantId: '', note: '' })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const t = await housekeeping.addTask({ ...form, date, attendantId: form.attendantId || null })
      toast({ title: `Added ${t.number}` })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="animate-rise space-y-4">
      <CardHeader title="Add a task" className="mb-0" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Unit" error={errors.unitId}>
          <Select className="w-full" value={form.unitId} options={units.map((u) => ({ value: u.id, label: u.code }))} onChange={(e) => setForm({ ...form, unitId: e.target.value })} />
        </Field>
        <Field label="Task" error={errors.type}>
          <Select className="w-full" value={form.type} options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABEL[t] }))} onChange={(e) => setForm({ ...form, type: e.target.value as TaskType })} />
        </Field>
        <Field label="Attendant">
          <Select className="w-full" value={form.attendantId} options={[{ value: '', label: 'Unassigned' }, ...attendants.map((a) => ({ value: a.id, label: a.name }))]} onChange={(e) => setForm({ ...form, attendantId: e.target.value })} />
        </Field>
        <Field label="Note">
          <Input className="h-10" value={form.note} placeholder="Deep clean after the long stay" onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </Field>
      </div>
      {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
      <Button variant="accent" loading={saving} onClick={() => void save()}>
        Add the task
      </Button>
    </Card>
  )
}

function SettingsForm({ initial, onDone }: { initial: HousekeepingSettings; onDone: () => void }) {
  const { housekeeping } = useServices()
  const toast = useToast()
  const [form, setForm] = useState(() => structuredClone(initial))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const setStandard = (type: TaskType, key: 'credits' | 'minutes', value: number) => setForm({ ...form, standards: { ...form.standards, [type]: { ...form.standards[type], [key]: value } } })

  async function save() {
    setSaving(true)
    try {
      await housekeeping.saveSettings(form)
      toast({ title: 'Saved the quota and standards', description: 'New tasks take the new credits; planned ones keep theirs.' })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="animate-rise space-y-4">
      <CardHeader title="Quota and standards" className="mb-0" />
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Daily quota per attendant, credits" error={errors.dailyQuota}>
          <Input className="h-10 w-32" type="number" min={1} step={0.5} value={form.dailyQuota} onChange={(e) => setForm({ ...form, dailyQuota: Number(e.target.value) })} />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <Switch checked={form.turndown} label="Plan turndowns" onChange={(turndown) => setForm({ ...form, turndown })} /> Plan a turndown for every stay in house
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {TASK_TYPES.map((type) => (
          <div key={type} className="rounded-xl bg-raised p-3">
            <p className="mb-2 text-sm font-semibold">{TASK_TYPE_LABEL[type]}</p>
            <div className="flex gap-2">
              <Field label="Credits" error={errors[`standards.${type}.credits`]}>
                <Input className="h-10" type="number" min={0.25} step={0.25} value={form.standards[type].credits} onChange={(e) => setStandard(type, 'credits', Number(e.target.value))} />
              </Field>
              <Field label="Minutes" error={errors[`standards.${type}.minutes`]}>
                <Input className="h-10" type="number" min={5} step={5} value={form.standards[type].minutes} onChange={(e) => setStandard(type, 'minutes', Number(e.target.value))} />
              </Field>
            </div>
          </div>
        ))}
      </div>
      {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
      <Button variant="accent" loading={saving} onClick={() => void save()}>
        Save
      </Button>
    </Card>
  )
}
