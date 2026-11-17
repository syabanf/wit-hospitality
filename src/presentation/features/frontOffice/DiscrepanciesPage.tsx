import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ClipboardCheck, Search, TriangleAlert } from 'lucide-react'
import type { CheckRow } from '@/application/frontOffice'
import { DISCREPANCY_ACTION_LABEL, DISCREPANCY_HINT, DISCREPANCY_LABEL, FOUND_LABEL, FOUND_STATUSES, RESOLVE_ACTIONS, type DiscrepancyAction, type DiscrepancyKind, type FoundStatus } from '@/domain/roomCheck'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag, type Tone } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'

type RoundFilter = 'all' | 'discrepancy' | 'unchecked' | 'matching'
const KIND_TONE: Record<DiscrepancyKind, Tone> = { sleep: 'accent', skip: 'danger', persons: 'warning' }
const FOUND_TONE: Record<FoundStatus, Tone> = { occupied: 'neutral', vacant: 'success', out_of_order: 'warning' }
const guests = (n: number | null) => (n === null ? '' : `, ${plural(n, 'guest')}`)

/**
 * The room discrepancy report: housekeeping records what it finds in each room, the page sets it
 * against the front office, and the desk resolves each sleep, skip or person count with what it did.
 * Works the same for hotel rooms and villas.
 */
export default function DiscrepanciesPage() {
  const { frontOffice } = useServices()
  const [params, setParams] = useSearchParams()
  const villaId = params.get('villa') ?? ''
  const date = params.get('date') ?? ''
  const data = useResource(`frontOffice.discrepancies:${villaId}:${date}`, () => frontOffice.roomReport.page(villaId || undefined, date || undefined))
  const filter = (params.get('show') ?? 'all') as RoundFilter
  const query = (params.get('q') ?? '').trim().toLowerCase()

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const set = (k: string, v: string) => {
    const search = new URLSearchParams(params)
    if (v && v !== 'all') search.set(k, v)
    else search.delete(k)
    setParams(search, { replace: true })
  }
  const searched = d.round.filter((r) => !query || r.unit.code.toLowerCase().includes(query) || (r.front?.guestName ?? '').toLowerCase().includes(query))
  const kindOf = (r: (typeof d.round)[number]): RoundFilter => (!r.check ? 'unchecked' : r.check.discrepancy ? 'discrepancy' : 'matching')
  const shown = searched.filter((r) => filter === 'all' || kindOf(r) === filter)
  const count = (f: RoundFilter) => searched.filter((r) => kindOf(r) === f).length

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 min-[1360px]:grid-cols-4">
        <StatTile label="Rooms checked" value={`${d.counts.checked} of ${d.counts.rooms}`} hint={`${d.villa.name}, ${shortDay(d.date)}`} onClick={() => set('show', 'unchecked')} active={filter === 'unchecked'} />
        <StatTile label="Discrepancies this day" value={d.counts.open + d.counts.resolved} hint={`${d.counts.open} open, ${d.counts.resolved} resolved`} onClick={() => set('show', 'discrepancy')} active={filter === 'discrepancy'} />
        <StatTile label="Open on every day" value={d.open.length} hint="The night audit waits on these" onClick={() => document.getElementById('fo-open')?.scrollIntoView({ behavior: 'smooth' })} />
        <StatTile label="Business date" value={shortDay(d.businessDate)} hint="The audit closes this day" to="/night-audit" />
      </div>

      <Card aria-labelledby="fo-open-title" id="fo-open" className={d.open.length ? 'ring-2 ring-warning' : undefined}>
        <CardHeader id="fo-open-title" title="Open discrepancies" icon={<TriangleAlert aria-hidden className="size-4 text-warning" />} action={<StatusPill tone={d.open.length ? 'warning' : 'success'}>{d.open.length || 'Clear'}</StatusPill>} />
        {d.open.length === 0 ? (
          <p className="text-sm text-muted">Housekeeping and the front office agree on every room.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.open.map((c) => (
              <OpenRow key={c.id} check={c} canResolve={d.canResolve} onDone={data.reload} />
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-0">
        <TableToolbar
          chips={[
            { value: 'all' as RoundFilter, label: 'All', count: searched.length },
            { value: 'discrepancy' as RoundFilter, label: 'Discrepancy', count: count('discrepancy') },
            { value: 'unchecked' as RoundFilter, label: 'Not checked', count: count('unchecked') },
            { value: 'matching' as RoundFilter, label: 'Matching', count: count('matching') },
          ]}
          chip={filter}
          onChip={(f) => set('show', f)}
          chipLabel="Round"
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Room or guest" aria-label="Search rooms" value={params.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} />}
          date={<Input type="date" aria-label="Day of the round" className="h-10 w-44" max={d.today} value={d.date} onChange={(e) => set('date', e.target.value)} />}
          filters={d.villas.length > 1 && <Select aria-label="Property" value={d.villa.id} options={d.villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => set('villa', e.target.value)} />}
          active={params.has('show') || params.has('q')}
          onClear={() => setParams(Object.fromEntries([...params].filter(([k]) => k === 'villa' || k === 'date')), { replace: true })}
          summary={`${plural(shown.length, 'room')} · ${d.villa.name} · ${shortDay(d.date)}`}
        />
      </Card>

      <Card aria-labelledby="fo-round">
        <CardHeader id="fo-round" title="Housekeeping round" icon={<ClipboardCheck aria-hidden className="size-4" />} />
        <p className="mb-3 text-xs text-muted">{d.canRecord ? 'Record what housekeeping found in each room. A room that disagrees with the front office lands on the open list.' : 'Housekeeping records the round; the desk resolves what disagrees.'}</p>
        {shown.length === 0 ? (
          <EmptyState title="No room matches">Clear the filters to see every room.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((r) => (
              <RoundRow key={`${r.unit.id}-${d.date}`} row={r} date={d.date} canRecord={d.canRecord && !r.check?.resolution} onDone={data.reload} />
            ))}
          </ul>
        )}
      </Card>

      {d.resolved.length > 0 && (
        <Card aria-labelledby="fo-resolved">
          <CardHeader id="fo-resolved" title="Resolved in the past week" action={<span className="text-sm text-muted">{d.resolved.length}</span>} />
          <ul className="divide-y divide-line text-sm">
            {d.resolved.map((c) => (
              <li key={c.id} className="py-2.5">
                <span className="font-medium text-fg">{c.unitCode}</span> <span className="text-muted">· {c.villaName} · {shortDay(c.date)}</span> <Tag tone={KIND_TONE[c.discrepancy ?? 'sleep']}>{DISCREPANCY_LABEL[c.discrepancy ?? 'sleep']}</Tag>
                <span className="mt-0.5 block text-xs text-muted">
                  {c.resolution && `${DISCREPANCY_ACTION_LABEL[c.resolution.action]}: ${c.resolution.note} (${c.resolution.by})`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/** One open discrepancy: what each side says and, for the desk, the form that settles it. */
function OpenRow({ check: c, canResolve, onDone }: { check: CheckRow; canResolve: boolean; onDone: () => void }) {
  const { frontOffice } = useServices()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const kind = c.discrepancy ?? 'sleep'

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await frontOffice.roomReport.resolve(c.id, { action: String(f.get('action')) as DiscrepancyAction, note: String(f.get('note') ?? '') })
      toast({ title: `Resolved ${c.unitCode}`, description: `${DISCREPANCY_LABEL[kind]} on ${shortDay(c.date)}` })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 text-sm">
          <p>
            <span className="font-semibold text-fg">{c.unitCode}</span> <span className="text-muted">· {c.villaName} · {shortDay(c.date)}</span> <Tag tone={KIND_TONE[kind]}>{DISCREPANCY_LABEL[kind]}</Tag>
          </p>
          <p className="mt-1 text-xs text-muted">
            Front office: {c.frontOffice === 'occupied' ? <>occupied by {c.bookingId ? <Link to={`/bookings/${c.bookingId}`} className="font-mono underline">{c.bookingCode}</Link> : 'a stay'}{c.guestName ? ` ${c.guestName}` : ''}{guests(c.frontPersons)}</> : 'vacant'}. Housekeeping: {FOUND_LABEL[c.found].toLowerCase()}{guests(c.persons)}, {c.checkedBy}.
          </p>
          {c.note && <p className="mt-0.5 text-xs text-body">{c.note}</p>}
          <p className="mt-0.5 text-xs text-muted">{DISCREPANCY_HINT[kind]}</p>
        </div>
        {canResolve && !open && (
          <Button size="sm" variant="soft" onClick={() => setOpen(true)}>
            Resolve
          </Button>
        )}
      </div>
      {open && (
        <form onSubmit={(e) => void submit(e)} className="mt-3 grid grid-cols-1 gap-3 rounded-panel bg-raised p-3 sm:grid-cols-[220px_minmax(0,1fr)_auto] sm:items-end" aria-label={`Resolve ${c.unitCode}`}>
          <Field label="What the desk did" htmlFor={`act-${c.id}`} error={errors.action}>
            <Select id={`act-${c.id}`} name="action" options={RESOLVE_ACTIONS[kind].map((a) => ({ value: a, label: DISCREPANCY_ACTION_LABEL[a] }))} />
          </Field>
          <Field label="Note" htmlFor={`note-${c.id}`} error={errors.note ?? errors.form}>
            <Input id={`note-${c.id}`} name="note" placeholder="What the desk found" autoFocus />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="accent" loading={saving}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  )
}

type RoundEntry = Awaited<ReturnType<ReturnType<typeof useServices>['frontOffice']['roomReport']['page']>>['round'][number]

/** One room of the round: the front office side, the recorded check, and the form housekeeping fills. */
function RoundRow({ row: r, date, canRecord, onDone }: { row: RoundEntry; date: string; canRecord: boolean; onDone: () => void }) {
  const { frontOffice } = useServices()
  const toast = useToast()
  const [found, setFound] = useState<FoundStatus>(r.check?.found ?? (r.front ? 'occupied' : 'vacant'))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const persons = String(f.get('persons') ?? '').trim()
    setSaving(true)
    setErrors({})
    try {
      const saved = await frontOffice.roomReport.record({ unitId: r.unit.id, date, found, persons: persons ? Number(persons) : null, note: String(f.get('note') ?? '') })
      toast({ tone: saved.discrepancy ? 'danger' : undefined, title: `Recorded ${r.unit.code}`, description: saved.discrepancy ? `${DISCREPANCY_LABEL[saved.discrepancy]} discrepancy: the desk resolves it.` : 'Matches the front office.' })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  const c = r.check
  return (
    <li className="grid grid-cols-1 gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:items-center">
      <div className="min-w-0 text-sm">
        <p>
          <Link to={`/property/units/${r.unit.id}`} className="font-semibold text-fg hover:underline">
            {r.unit.code}
          </Link>
          {r.floor && <span className="text-muted"> · {r.floor}</span>}
          {c && (
            <span className="ml-2">
              {c.discrepancy ? <Tag tone={c.resolution ? 'neutral' : KIND_TONE[c.discrepancy]}>{DISCREPANCY_LABEL[c.discrepancy]}{c.resolution ? ', resolved' : ''}</Tag> : <Tag tone="success">Matches</Tag>}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted">
          Front office: {r.front ? <>in house, <Link to={`/bookings/${r.front.id}`} className="font-mono underline">{r.front.code}</Link> {r.front.guestName}{guests(r.front.persons)}</> : 'vacant'}
        </p>
        {c && (
          <p className="mt-0.5 text-xs text-muted">
            Housekeeping: <StatusPill tone={FOUND_TONE[c.found]}>{FOUND_LABEL[c.found]}</StatusPill>
            {guests(c.persons)} · {c.checkedBy}, {c.checkedAt.slice(11, 16)}
            {c.note && ` · ${c.note}`}
          </p>
        )}
      </div>
      {canRecord && (
        <form onSubmit={(e) => void submit(e)} className="grid grid-cols-2 gap-2 sm:grid-cols-[150px_90px_minmax(0,1fr)_auto] sm:items-start" aria-label={`Record ${r.unit.code}`}>
          <Select aria-label={`What housekeeping found in ${r.unit.code}`} value={found} onChange={(e) => setFound(e.target.value as FoundStatus)} options={FOUND_STATUSES.map((s) => ({ value: s, label: FOUND_LABEL[s] }))} />
          <div>
            <Input name="persons" type="number" inputMode="numeric" min={1} max={20} aria-label={`Guests seen in ${r.unit.code}`} placeholder="Guests" disabled={found !== 'occupied'} defaultValue={c?.persons ?? ''} className="tabular" />
            {errors.persons && <p role="alert" className="mt-1 text-xs font-medium text-danger">{errors.persons}</p>}
          </div>
          <div className="col-span-2 sm:col-span-1">
            <Input name="note" aria-label={`Note on ${r.unit.code}`} placeholder="Note" defaultValue={c?.note ?? ''} />
            {(errors.note ?? errors.date ?? errors.found ?? errors.form) && <p role="alert" className="mt-1 text-xs font-medium text-danger">{errors.note ?? errors.date ?? errors.found ?? errors.form}</p>}
          </div>
          <Button type="submit" size="sm" variant={c ? 'soft' : 'solid'} loading={saving} className="col-span-2 sm:col-span-1">
            {c ? 'Update' : 'Record'}
          </Button>
        </form>
      )}
    </li>
  )
}
