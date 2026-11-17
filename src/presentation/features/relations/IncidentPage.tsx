import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Pencil } from 'lucide-react'
import { INCIDENT_KIND_LABEL, INCIDENT_STATUS_LABEL, PERSON_KIND_LABEL, SEVERITY_LABEL, type IncidentEntry } from '@/domain/relations'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { AttachmentList } from '../shared/Attachments'
import { IncidentForm } from './IncidentForm'
import { INCIDENT_TONE, SEVERITY_TONE, useRun, when } from './shared'
import { Timeline } from './Timeline'

const ENTRY_LABEL: Record<IncidentEntry['kind'], string> = { logged: 'Logged', follow_up: 'Follow-up', charge: 'Charged', closed: 'Signed off' }

/** One incident: what happened, who was there, the follow-ups, a damage charge and the manager's sign-off. */
export default function IncidentPage() {
  const { id = '' } = useParams()
  return <IncidentDetail key={id} id={id} />
}

function IncidentDetail({ id }: { id: string }) {
  const { incidents } = useServices()
  const { can } = useAccess()
  const resource = useResource(`incidents.detail:${id}`, () => incidents.detail(id), { keepPrevious: false })
  const { busy, errors, run } = useRun(resource.reload)
  const [editing, setEditing] = useState(false)

  return (
    <Gate resource={resource} what="incident" back={{ to: '/incidents', label: 'Back to incidents' }}>
      {(d) => {
        const i = d.incident
        const edit = can('guest', 'edit') && i.status !== 'closed'
        const submit = (key: string, title: string, action: (f: FormData) => Promise<unknown>) => (e: FormEvent<HTMLFormElement>) => {
          e.preventDefault()
          const form = e.currentTarget
          void run(key, title, () => action(new FormData(form))).then((ok) => ok && form.reset())
        }
        return (
          <>
            <PageBar
              fallback="/incidents"
              label="Incidents"
              actions={
                edit && (
                  <Button variant="card" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                    <Pencil aria-hidden className="size-4" /> Edit
                  </Button>
                )
              }
            />
            {editing ? (
              <Card as="div" aria-label={`Edit ${i.number}`}>
                <IncidentForm
                  catalog={d.catalog}
                  stays={d.stays}
                  today={d.today}
                  initial={i}
                  onCancel={() => setEditing(false)}
                  onDone={() => {
                    setEditing(false)
                    resource.reload()
                  }}
                />
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0 space-y-4">
                  <Card aria-label={`Incident ${i.number}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-mono text-xs text-muted">
                          {i.number} · reported by {i.reportedBy}
                        </p>
                        <Headline className="mt-1">{INCIDENT_KIND_LABEL[i.kind]}</Headline>
                        <p className="mt-1 text-sm text-muted">
                          {i.villaName}
                          {i.unitCode && `, ${i.unitCode}`}
                          {i.area && ` · ${i.area}`}
                          {i.bookingId && (
                            <>
                              {' · '}
                              <Link to={`/bookings/${i.bookingId}`} className="hover:underline">
                                {i.bookingCode}
                              </Link>
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex gap-1.5">
                        <Tag tone={SEVERITY_TONE[i.severity]}>{SEVERITY_LABEL[i.severity]}</Tag>
                        <Tag tone={INCIDENT_TONE[i.status]}>{INCIDENT_STATUS_LABEL[i.status]}</Tag>
                      </div>
                    </div>
                    <p className="mt-4 text-sm text-body">{i.description}</p>
                    {i.actions && (
                      <p className="mt-2 text-sm">
                        <span className="font-medium">Actions taken: </span>
                        {i.actions}
                      </p>
                    )}
                    <FactGrid
                      className="mt-4 grid-cols-2 sm:grid-cols-4"
                      facts={[
                        ['When', when(i.occurredAt)],
                        ['Police', i.policeCalled ? `Called${i.policeReport ? `, ${i.policeReport}` : ''}` : 'Not called'],
                        ['Doctor', i.doctorCalled ? 'Called' : 'Not called'],
                        ['Damage charged', i.charge ? money(i.charge.amount) : 'None'],
                      ]}
                    />
                    {i.people.length > 0 && (
                      <ul className="mt-4 space-y-1 text-sm">
                        {i.people.map((p, n) => (
                          <li key={n}>
                            <span className="text-muted">{PERSON_KIND_LABEL[p.kind]}: </span>
                            {p.guestId ? (
                              <Link to={`/guests/${p.guestId}`} className="text-accent-text hover:underline">
                                {p.name}
                              </Link>
                            ) : (
                              p.name
                            )}
                            {p.note && <span className="text-muted"> · {p.note}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {i.attachments.length > 0 && (
                      <div className="mt-4">
                        <AttachmentList files={i.attachments} />
                      </div>
                    )}
                  </Card>
                  <Card aria-labelledby="in-timeline">
                    <CardHeader id="in-timeline" title="Follow-up" />
                    <Timeline entries={i.timeline.map((e) => ({ at: e.at, by: e.by, label: ENTRY_LABEL[e.kind], note: e.note }))} />
                    {edit && (
                      <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={submit('follow', `Followed up ${i.number}`, (f) => incidents.followUp(i.id, String(f.get('note') ?? '')))}>
                        <Field label="Follow-up" htmlFor="in-follow" error={errors.note} className="min-w-48 flex-1">
                          <Input id="in-follow" name="note" placeholder="Insurer called back" />
                        </Field>
                        <Button type="submit" variant="solid" loading={busy === 'follow'}>
                          Add
                        </Button>
                      </form>
                    )}
                  </Card>
                </div>
                <div className="space-y-4">
                  {edit && i.kind === 'damage' && !i.charge && (
                    <Card aria-labelledby="in-charge">
                      <CardHeader id="in-charge" title="Charge the guest" />
                      {i.bookingId ? (
                        <form className="space-y-3" onSubmit={submit('charge', `Charged the damage to ${i.bookingCode}`, (f) => incidents.charge(i.id, Number(f.get('amount') || 0), String(f.get('reason') ?? '')))}>
                          <Field label="Amount, rupiah" htmlFor="in-amount" error={errors.amount}>
                            <Input id="in-amount" name="amount" type="number" min={1} step={1} inputMode="numeric" />
                          </Field>
                          <Field label="Reason" htmlFor="in-reason" error={errors.reason}>
                            <Input id="in-reason" name="reason" placeholder="Cracked glass table top" />
                          </Field>
                          <Button type="submit" variant="card" loading={busy === 'charge'}>
                            Post to {i.bookingCode}
                          </Button>
                        </form>
                      ) : (
                        <p className="text-sm text-muted">Link the guest's stay with Edit before charging the damage.</p>
                      )}
                    </Card>
                  )}
                  {i.signOff ? (
                    <Card aria-labelledby="in-signoff">
                      <CardHeader id="in-signoff" title="Signed off" />
                      <p className="text-sm">{i.signOff.note}</p>
                      <p className="text-xs text-muted">
                        {when(i.signOff.at)} · {i.signOff.by}
                      </p>
                    </Card>
                  ) : (
                    edit &&
                    d.mayApprove && (
                      <Card aria-labelledby="in-close">
                        <CardHeader id="in-close" title="Sign off and close" />
                        <form className="space-y-3" onSubmit={submit('close', `Signed off ${i.number}`, (f) => incidents.close(i.id, String(f.get('note') ?? '')))}>
                          <Field label="Closing note" htmlFor="in-close-note" error={errors.note}>
                            <Input id="in-close-note" name="note" placeholder="What was settled" />
                          </Field>
                          <Button type="submit" variant="accent" loading={busy === 'close'}>
                            Sign off {i.number}
                          </Button>
                        </form>
                      </Card>
                    )
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
