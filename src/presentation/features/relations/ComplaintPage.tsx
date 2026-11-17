import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Check, Play, RotateCcw, Wrench, Sparkles } from 'lucide-react'
import { TASK_TYPE_LABEL, TASK_TYPES, type TaskType } from '@/domain/housekeeping'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, type MaintenanceCategory } from '@/domain/maintenance'
import {
  COMPENSATION_KIND_LABEL,
  COMPENSATION_KINDS,
  COMPENSATION_STATUS_LABEL,
  COMPLAINT_CATEGORY_LABEL,
  COMPLAINT_STATUS_LABEL,
  complaintMoves,
  isOpenComplaint,
  SEVERITY_LABEL,
  type ComplaintEntry,
  type CompensationKind,
} from '@/domain/relations'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { COMPENSATION_TONE, COMPLAINT_TONE, SEVERITY_TONE, useRun, when } from './shared'
import { Timeline } from './Timeline'

const ENTRY_LABEL: Record<ComplaintEntry['kind'], string> = { logged: 'Logged', note: 'Note', status: 'Status', resolved: 'Resolved', compensation: 'Compensation', link: 'Raised' }

/** One complaint: who said what, its owner and status, the resolution and compensation, and what was done since. */
export default function ComplaintPage() {
  const { id = '' } = useParams()
  return <ComplaintDetail key={id} id={id} />
}

function ComplaintDetail({ id }: { id: string }) {
  const { complaints } = useServices()
  const { can } = useAccess()
  const resource = useResource(`complaints.detail:${id}`, () => complaints.detail(id), { keepPrevious: false })
  const { busy, errors, run } = useRun(resource.reload)
  const [kind, setKind] = useState<CompensationKind | ''>('')

  return (
    <Gate resource={resource} what="complaint" back={{ to: '/complaints', label: 'Back to complaints' }}>
      {(d) => {
        const c = d.complaint
        const edit = can('guest', 'edit') && c.status !== 'closed'
        const moves = edit ? complaintMoves(c.status) : []
        const linkOf = (e: ComplaintEntry) =>
          e.ref ? (
            <Link to={e.ref.kind === 'work_order' ? `/maintenance/work-orders/${e.ref.id}` : '/housekeeping'} className="text-accent-text hover:underline">
              {e.ref.label}
            </Link>
          ) : undefined
        return (
          <>
            <PageBar
              fallback="/complaints"
              label="Complaints"
              actions={
                <>
                  {moves.map((to) => (
                    <Button key={to} variant={to === 'closed' ? 'accent' : 'card'} loading={busy === to} onClick={() => void run(to, `${c.number} ${COMPLAINT_STATUS_LABEL[to].toLowerCase()}`, () => complaints.move(c.id, to as 'in_progress' | 'closed', ''))}>
                      {to === 'closed' ? <Check aria-hidden className="size-4" /> : c.status === 'resolved' ? <RotateCcw aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
                      {to === 'closed' ? 'Close' : c.status === 'resolved' ? 'Reopen' : 'Start work'}
                    </Button>
                  ))}
                </>
              }
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="min-w-0 space-y-4">
                <Card aria-label={`Complaint ${c.number}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">
                        {c.number} · {c.source === 'stay_page' ? 'from the stay page' : 'logged at the desk'}
                      </p>
                      <Headline className="mt-1">{`${COMPLAINT_CATEGORY_LABEL[c.category]} complaint`}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        <Link to={`/guests/${c.guestId}`} className="text-accent-text hover:underline">
                          {c.guestName}
                        </Link>
                        {c.bookingId && (
                          <>
                            {' · '}
                            <Link to={`/bookings/${c.bookingId}`} className="hover:underline">
                              {c.bookingCode}
                            </Link>
                          </>
                        )}
                        {' · '}
                        {c.villaName}
                        {c.unitCode && `, ${c.unitCode}`}
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      <Tag tone={SEVERITY_TONE[c.severity]}>{SEVERITY_LABEL[c.severity]}</Tag>
                      <Tag tone={COMPLAINT_TONE[c.status]}>{COMPLAINT_STATUS_LABEL[c.status]}</Tag>
                    </div>
                  </div>
                  <blockquote className="mt-4 rounded-panel bg-raised p-4 text-sm text-body">{c.description}</blockquote>
                  <FactGrid
                    className="mt-4 grid-cols-2 sm:grid-cols-4"
                    facts={[
                      ['Received', when(c.receivedAt)],
                      ['Received by', c.receivedBy],
                      ['Owner', c.owner],
                      ['Resolved in', c.resolutionHours === null ? 'Not yet' : `${c.resolutionHours} h`],
                    ]}
                  />
                </Card>

                {c.resolution && (
                  <Card aria-labelledby="cp-resolution">
                    <CardHeader id="cp-resolution" title="Resolution" />
                    <p className="text-sm">{c.resolution.action}</p>
                    <p className="text-xs text-muted">
                      {when(c.resolution.at)} · {c.resolution.by}
                    </p>
                    {c.compensation && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-panel bg-raised p-3 text-sm">
                        <span className="font-medium">{COMPENSATION_KIND_LABEL[c.compensation.kind]}</span>
                        {c.compensation.kind === 'folio_credit' && <span className="tabular">{money(c.compensation.amount)}</span>}
                        <span className="text-muted">{c.compensation.description}</span>
                        <Tag tone={COMPENSATION_TONE[c.compensation.status]}>{COMPENSATION_STATUS_LABEL[c.compensation.status]}</Tag>
                      </div>
                    )}
                    {c.compensation?.status === 'pending_approval' && d.mayApprove && (
                      <form
                        className="mt-3 flex flex-wrap items-end gap-2"
                        onSubmit={(e: FormEvent<HTMLFormElement>) => {
                          e.preventDefault()
                          const f = new FormData(e.currentTarget)
                          const approve = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'approve'
                          void run('decide', approve ? `Approved the credit on ${c.number}` : `Refused the credit on ${c.number}`, () => complaints.decide(c.id, approve, String(f.get('note') ?? '')))
                        }}
                      >
                        <Field label="Note" htmlFor="cp-decide-note" error={errors.note} className="min-w-48 flex-1">
                          <Input id="cp-decide-note" name="note" placeholder="Needed to refuse" />
                        </Field>
                        <Button type="submit" value="approve" variant="accent" loading={busy === 'decide'}>
                          Approve and post
                        </Button>
                        <Button type="submit" value="refuse" variant="soft">
                          Refuse
                        </Button>
                      </form>
                    )}
                  </Card>
                )}

                {edit && isOpenComplaint(c.status) && (
                  <Card aria-labelledby="cp-resolve">
                    <CardHeader id="cp-resolve" title="Resolve" />
                    <form
                      className="grid grid-cols-1 gap-4 sm:grid-cols-2"
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const f = new FormData(e.currentTarget)
                        const compensation = kind ? { kind, amount: kind === 'folio_credit' ? Number(f.get('amount') || 0) : 0, description: String(f.get('compDescription') ?? '') } : null
                        void run('resolve', `Resolved ${c.number}`, () => complaints.resolve(c.id, { action: String(f.get('action') ?? ''), compensation }))
                      }}
                    >
                      <Field label="What was done" htmlFor="cp-action" error={errors.action} className="sm:col-span-2">
                        <Textarea id="cp-action" name="action" rows={2} />
                      </Field>
                      <Field label="Compensation" htmlFor="cp-comp" error={errors['compensation.kind']}>
                        <Select id="cp-comp" className="w-full" value={kind} onChange={(e) => setKind(e.target.value as CompensationKind | '')} options={[{ value: '', label: 'None' }, ...COMPENSATION_KINDS.map((k) => ({ value: k, label: COMPENSATION_KIND_LABEL[k] }))]} />
                      </Field>
                      {kind === 'folio_credit' && (
                        <Field label="Credit, rupiah" htmlFor="cp-amount" error={errors['compensation.amount']} hint={`Above ${money(d.limit)} a manager approves it${!c.bookingId ? '; link the stay first' : ''}`}>
                          <Input id="cp-amount" name="amount" type="number" min={1} step={1} inputMode="numeric" />
                        </Field>
                      )}
                      {kind && (
                        <Field label="What the guest gets" htmlFor="cp-comp-desc" error={errors['compensation.description']} className="sm:col-span-2" hint={kind === 'free_service' ? 'Place the order on the house in room service' : undefined}>
                          <Input id="cp-comp-desc" name="compDescription" placeholder={kind === 'goodwill' ? 'Fruit platter and a note' : kind === 'free_service' ? 'Dinner for two on the house' : 'One night of air conditioning trouble'} />
                        </Field>
                      )}
                      {errors.form && <p className="text-xs font-medium text-danger sm:col-span-2">{errors.form}</p>}
                      <div className="sm:col-span-2">
                        <Button type="submit" variant="solid" loading={busy === 'resolve'}>
                          Resolve {c.number}
                        </Button>
                      </div>
                    </form>
                  </Card>
                )}

                <Card aria-labelledby="cp-timeline">
                  <CardHeader id="cp-timeline" title="Timeline" />
                  <Timeline entries={c.timeline.map((e) => ({ at: e.at, by: e.by, label: ENTRY_LABEL[e.kind], note: e.note, link: linkOf(e) }))} />
                  {edit && (
                    <form
                      className="mt-4 flex flex-wrap items-end gap-2"
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const form = e.currentTarget
                        void run('note', `Noted on ${c.number}`, () => complaints.note(c.id, String(new FormData(form).get('note') ?? ''))).then((ok) => ok && form.reset())
                      }}
                    >
                      <Field label="Follow-up note" htmlFor="cp-note" error={errors.note} className="min-w-48 flex-1">
                        <Input id="cp-note" name="note" placeholder="Called the guest back" />
                      </Field>
                      <Button type="submit" variant="solid" loading={busy === 'note'}>
                        Add note
                      </Button>
                    </form>
                  )}
                </Card>
              </div>

              <div className="space-y-4">
                {edit && can('maintenance', 'create') && (
                  <Card aria-labelledby="cp-wo">
                    <CardHeader id="cp-wo" title="Raise a work order" icon={<Wrench aria-hidden className="size-4" />} />
                    <form
                      className="space-y-3"
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const f = new FormData(e.currentTarget)
                        void run('wo', `Raised a work order for ${c.number}`, () =>
                          complaints.raiseWorkOrder(c.id, { villaId: c.villaId, unitId: c.unitId, assetId: null, category: String(f.get('category')) as MaintenanceCategory, priority: c.severity === 'high' ? 'urgent' : 'high', title: String(f.get('title') ?? ''), description: `${c.number}: ${c.description}`, assigneeId: null, vendorId: null, scheduledOn: null, parts: [], labourCost: 0, vendorCost: 0, beforePhotos: [], afterPhotos: [] }),
                        )
                      }}
                    >
                      <Field label="Job" htmlFor="cp-wo-title" error={errors.title}>
                        <Input id="cp-wo-title" name="title" defaultValue={`${COMPLAINT_CATEGORY_LABEL[c.category]}: ${c.description}`.slice(0, 80)} />
                      </Field>
                      <Field label="Trade" htmlFor="cp-wo-cat" error={errors.category}>
                        <Select id="cp-wo-cat" name="category" className="w-full" defaultValue="other" options={MAINTENANCE_CATEGORIES.map((m) => ({ value: m, label: MAINTENANCE_CATEGORY_LABEL[m] }))} />
                      </Field>
                      <Button type="submit" variant="card" loading={busy === 'wo'}>
                        Open the work order
                      </Button>
                    </form>
                  </Card>
                )}
                {edit && can('maintenance', 'edit') && c.unitId && (
                  <Card aria-labelledby="cp-hk">
                    <CardHeader id="cp-hk" title="Ask housekeeping" icon={<Sparkles aria-hidden className="size-4" />} />
                    <form
                      className="space-y-3"
                      onSubmit={(e: FormEvent<HTMLFormElement>) => {
                        e.preventDefault()
                        const f = new FormData(e.currentTarget)
                        void run('task', `Asked housekeeping for ${c.unitCode}`, () => complaints.raiseTask(c.id, { unitId: c.unitId!, date: String(f.get('date') ?? ''), type: String(f.get('type')) as TaskType, attendantId: null, note: `${c.number}: ${c.description}` }))
                      }}
                    >
                      <Field label="Task" htmlFor="cp-hk-type" error={errors.type}>
                        <Select id="cp-hk-type" name="type" className="w-full" defaultValue="deep" options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABEL[t] }))} />
                      </Field>
                      <Field label="Day" htmlFor="cp-hk-date" error={errors.date}>
                        <Input id="cp-hk-date" name="date" type="date" defaultValue={d.today} />
                      </Field>
                      <Button type="submit" variant="card" loading={busy === 'task'}>
                        Add the task for {c.unitCode}
                      </Button>
                    </form>
                  </Card>
                )}
                {c.links.length > 0 && (
                  <Card aria-labelledby="cp-links">
                    <CardHeader id="cp-links" title="Raised from it" />
                    <ul className="space-y-2 text-sm">
                      {c.links.map((l) => (
                        <li key={l.id}>
                          <Link to={l.kind === 'work_order' ? `/maintenance/work-orders/${l.id}` : '/housekeeping'} className="text-accent-text hover:underline">
                            {l.kind === 'work_order' ? 'Work order' : 'Housekeeping'} {l.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}
