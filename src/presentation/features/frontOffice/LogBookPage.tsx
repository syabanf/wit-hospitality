import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { BellRing, NotebookPen, Search } from 'lucide-react'
import { LOG_CATEGORIES, LOG_CATEGORY_LABEL, LOG_SHIFT_HOURS, LOG_SHIFT_LABEL, LOG_SHIFTS, type LogCategory, type LogEntry, type LogLinkKind, type LogShift } from '@/domain/logBook'
import { fullDay, shortDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag, type Tone } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { CheckRow } from '../shared/CheckRow'

const CATEGORY_TONE: Record<LogCategory, Tone> = { handover: 'info', guest: 'neutral', maintenance: 'warning', cash: 'success', security: 'danger', other: 'neutral' }
const LINK_TO: Record<LogLinkKind, (id: string) => string> = { booking: (id) => `/bookings/${id}`, unit: (id) => `/property/units/${id}`, guest: (id) => `/guests/${id}` }
const RANGES = [
  { value: '0', label: 'Today' },
  { value: '6', label: 'Past 7 days' },
  { value: '29', label: 'Past 30 days' },
]

type Page = Awaited<ReturnType<ReturnType<typeof useServices>['frontOffice']['logBook']['page']>>

/**
 * The front office log book: what each shift tells the next. Open follow-ups stay on top until
 * someone marks them done; the next shift acknowledges them on the way. Filters live in the URL.
 */
export default function LogBookPage() {
  const { frontOffice } = useServices()
  const [params, setParams] = useSearchParams()
  const range = params.get('range') ?? '6'
  const category = (params.get('category') ?? 'all') as LogCategory | 'all'
  const shift = (params.get('shift') ?? 'all') as LogShift | 'all'
  const query = params.get('q') ?? ''
  const followUp = params.get('followUp') === '1'
  const data = useResource(`frontOffice.logBook:${range}:${category}:${shift}:${query}:${followUp}`, () => frontOffice.logBook.page({ days: Number(range), category, shift, query, followUp }))

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const set = (k: string, v: string) => {
    const search = new URLSearchParams(params)
    if (v && v !== 'all') search.set(k, v)
    else search.delete(k)
    setParams(search, { replace: true })
  }

  return (
    <div className="space-y-4">
      {d.followUps.length > 0 && (
        <Card aria-labelledby="lb-follow" className="ring-2 ring-warning">
          <CardHeader id="lb-follow" title="Open follow-ups" icon={<BellRing aria-hidden className="size-4 text-warning" />} action={<span className="text-sm text-muted">{d.followUps.length}</span>} />
          <ul className="divide-y divide-line">
            {d.followUps.map((e) => (
              <FollowUp key={e.id} entry={e} me={d.me} canWrite={d.canWrite} onDone={data.reload} />
            ))}
          </ul>
        </Card>
      )}

      {d.canWrite && <NewEntry page={d} onDone={data.reload} />}

      <Card className="p-0">
        <TableToolbar
          chips={[{ value: 'all' as LogCategory | 'all', label: 'All' }, ...LOG_CATEGORIES.map((c) => ({ value: c as LogCategory | 'all', label: LOG_CATEGORY_LABEL[c] }))]}
          chip={category}
          onChip={(c) => set('category', c)}
          chipLabel="Category"
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Text, author, room" aria-label="Search the log book" value={query} onChange={(e) => set('q', e.target.value)} />}
          filters={
            <>
              <Select aria-label="Period" value={range} options={RANGES} onChange={(e) => set('range', e.target.value === '6' ? '' : e.target.value)} />
              <Select aria-label="Shift" value={shift} options={[{ value: 'all', label: 'Every shift' }, ...LOG_SHIFTS.map((s) => ({ value: s, label: `${LOG_SHIFT_LABEL[s]}, ${LOG_SHIFT_HOURS[s]}` }))]} onChange={(e) => set('shift', e.target.value)} />
              <Button size="sm" variant={followUp ? 'solid' : 'soft'} aria-pressed={followUp} onClick={() => set('followUp', followUp ? '' : '1')}>
                Follow-ups only
              </Button>
            </>
          }
          active={[...params.keys()].length > 0}
          onClear={() => setParams({}, { replace: true })}
          summary={`${d.total === 1 ? '1 entry' : `${d.total} entries`} since ${shortDay(d.from)}`}
        />
      </Card>

      {d.groups.length === 0 ? (
        <Card>
          <EmptyState title="No entry matches">Clear the filters or widen the period.</EmptyState>
        </Card>
      ) : (
        d.groups.map((g) => (
          <Card key={`${g.date}-${g.shift}`} aria-labelledby={`lb-${g.date}-${g.shift}`}>
            <CardHeader id={`lb-${g.date}-${g.shift}`} title={`${fullDay(g.date)}, ${LOG_SHIFT_LABEL[g.shift].toLowerCase()} shift`} action={<span className="text-sm text-muted">{LOG_SHIFT_HOURS[g.shift]}</span>} />
            <ul className="divide-y divide-line">
              {g.entries.map((e) => (
                <li key={e.id} id={e.id} className="py-3 text-sm">
                  <EntryLine entry={e} shift={d.shifts[e.id]} />
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  )
}

function EntryLine({ entry: e, shift }: { entry: LogEntry; shift?: { id: string; number: string } }) {
  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span className="font-medium text-fg tabular">{e.at.slice(11, 16)}</span>
        <span>{e.author}</span>
        <Tag tone={CATEGORY_TONE[e.category]}>{LOG_CATEGORY_LABEL[e.category]}</Tag>
        {e.followUp && <Tag tone={e.doneBy ? 'success' : 'warning'}>{e.doneBy ? 'Follow-up done' : 'Follow-up'}</Tag>}
        {e.link && (
          <Link to={LINK_TO[e.link.kind](e.link.id)} className="font-mono underline">
            {e.link.label}
          </Link>
        )}
        {shift && (
          <Link to={`/finance/shifts/${shift.id}`} className="font-mono underline">
            {shift.number}
          </Link>
        )}
      </p>
      <p className="mt-1 whitespace-pre-line text-body">{e.text}</p>
      {(e.acknowledgedBy || e.doneBy) && (
        <p className="mt-1 text-xs text-muted">
          {e.acknowledgedBy && `Acknowledged by ${e.acknowledgedBy} at ${e.acknowledgedAt?.slice(11, 16)}`}
          {e.doneBy && `${e.acknowledgedBy ? '. ' : ''}Done by ${e.doneBy} at ${e.doneAt?.slice(11, 16)}${e.doneNote ? `: ${e.doneNote}` : ''}`}
        </p>
      )}
    </>
  )
}

/** An open follow-up: the next shift acknowledges it, anyone marks it done with a note. */
function FollowUp({ entry: e, me, canWrite, onDone }: { entry: LogEntry; me: string; canWrite: boolean; onDone: () => void }) {
  const { frontOffice } = useServices()
  const toast = useToast()
  const [busy, setBusy] = useState<'ack' | 'done' | null>(null)
  const [note, setNote] = useState('')

  async function act(kind: 'ack' | 'done') {
    setBusy(kind)
    try {
      if (kind === 'ack') await frontOffice.logBook.acknowledge(e.id)
      else await frontOffice.logBook.done(e.id, note)
      toast({ title: kind === 'ack' ? `Acknowledged the note of ${e.author}` : `Marked the note of ${e.author} done` })
      onDone()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not update the note', description: error instanceof Error ? error.message : undefined })
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="py-3 text-sm">
      <p className="mb-1 text-xs text-muted">{shortDay(e.date)}, {LOG_SHIFT_LABEL[e.shift].toLowerCase()} shift</p>
      <EntryLine entry={e} />
      {canWrite && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!e.acknowledgedBy && e.authorId !== me && (
            <Button size="sm" variant="soft" loading={busy === 'ack'} onClick={() => void act('ack')}>
              Acknowledge
            </Button>
          )}
          <Input className="h-9 w-full sm:w-64" aria-label={`Note on closing the follow-up of ${e.author}`} placeholder="What was done (optional)" value={note} onChange={(x) => setNote(x.target.value)} />
          <Button size="sm" variant="solid" loading={busy === 'done'} onClick={() => void act('done')}>
            Mark done
          </Button>
        </div>
      )}
    </li>
  )
}

/** The form for a new entry: category, property, an optional link and the follow-up flag. */
function NewEntry({ page: d, onDone }: { page: Page; onDone: () => void }) {
  const { frontOffice } = useServices()
  const toast = useToast()
  const [linkKind, setLinkKind] = useState<LogLinkKind | ''>('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [key, setKey] = useState(0)
  const options = linkKind === 'booking' ? d.links.bookings : linkKind === 'unit' ? d.links.units : linkKind === 'guest' ? d.links.guests : []

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const linkId = String(f.get('linkId') ?? '')
    setSaving(true)
    setErrors({})
    try {
      const saved = await frontOffice.logBook.write({
        category: String(f.get('category')) as LogCategory,
        text: String(f.get('text') ?? ''),
        villaId: String(f.get('villaId') ?? '') || null,
        link: linkKind && linkId ? { kind: linkKind, id: linkId } : null,
        followUp: f.get('followUp') === 'on',
      })
      toast({ title: `Logged a ${LOG_CATEGORY_LABEL[saved.category].toLowerCase()} note`, description: saved.followUp ? 'The next shift sees it on top until it is done.' : `${LOG_SHIFT_LABEL[saved.shift]} shift, ${shortDay(saved.date)}` })
      setLinkKind('')
      setKey((k) => k + 1)
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card aria-labelledby="lb-new">
      <CardHeader id="lb-new" title="New entry" icon={<NotebookPen aria-hidden className="size-4" />} />
      <form key={key} onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="New log book entry">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Category" htmlFor="lb-category" error={errors.category}>
            <Select id="lb-category" name="category" defaultValue="guest" options={LOG_CATEGORIES.map((c) => ({ value: c, label: LOG_CATEGORY_LABEL[c] }))} />
          </Field>
          <Field label="Property" htmlFor="lb-villa" error={errors.villaId}>
            <Select id="lb-villa" name="villaId" options={[{ value: '', label: 'Every property' }, ...d.villas.map((v) => ({ value: v.id, label: v.name }))]} />
          </Field>
          <Field label="About" htmlFor="lb-link-kind">
            <Select id="lb-link-kind" value={linkKind} onChange={(e) => setLinkKind(e.target.value as LogLinkKind | '')} options={[{ value: '', label: 'Nothing in particular' }, { value: 'booking', label: 'A booking' }, { value: 'unit', label: 'A room' }, { value: 'guest', label: 'A guest' }]} />
          </Field>
          {linkKind && (
            <Field label="Which one" htmlFor="lb-link" error={errors.link}>
              <Select id="lb-link" name="linkId" options={options.map((o) => ({ value: o.id, label: o.label }))} />
            </Field>
          )}
        </div>
        <Field label="Entry" htmlFor="lb-text" error={errors.text ?? errors.form}>
          <Textarea id="lb-text" name="text" rows={3} maxLength={1000} placeholder="What the next shift needs to know" />
        </Field>
        <CheckRow name="followUp" label="Needs follow-up" hint="The next shift acknowledges it; it stays on top and on the dashboard until someone marks it done." />
        <Button type="submit" variant="accent" loading={saving}>
          Add to the log book
        </Button>
      </form>
    </Card>
  )
}
