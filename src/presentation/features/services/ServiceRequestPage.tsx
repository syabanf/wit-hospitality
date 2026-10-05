import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Check, Pencil, Play, Receipt, UserRound, XCircle } from 'lucide-react'
import { canEditRequest, clockLabel, nextServiceStep, SERVICE_ACTION_LABEL, SERVICE_KIND_LABEL, SERVICE_STATUS_LABEL, type ServiceStatus } from '@/domain/roomService'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { Steps } from '../../ui/Steps'
import { useToast } from '../../ui/useToast'
import { SERVICE_TONE } from '../shared/tones'
import { RequestForm } from './RequestForm'

const STEP_ORDER: ServiceStatus[] = ['open', 'in_progress', 'done']

export default function ServiceRequestPage() {
  const { id = '' } = useParams()
  const { service } = useServices()
  const toast = useToast()
  const resource = useResource(`service.detail:${id}`, () => service.detail(id), { keepPrevious: false })
  const [busy, setBusy] = useState<'step' | 'cancel' | 'assign' | 'charge' | null>(null)
  const [editing, setEditing] = useState(false)
  const options = useResource('service.formOptions', () => service.formOptions())
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function run(key: NonNullable<typeof busy>, label: string, action: () => Promise<unknown>, description?: string) {
    setBusy(key)
    setErrors({})
    try {
      await action()
      toast({ title: label, description })
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
    <Gate resource={resource} what="request" back={{ to: '/services', label: 'Back to room services' }}>
      {({ request: r, cashbox }) => {
        const step = nextServiceStep(r)
        const at = r.status === 'cancelled' ? -1 : STEP_ORDER.indexOf(r.status)
        const steps = STEP_ORDER.map((s, i) => ({ id: s, label: SERVICE_STATUS_LABEL[s], hint: s === 'open' ? `${shortDay(r.requestedOn)} ${clockLabel(r.requestedAt)}` : s === 'done' && r.doneOn ? shortDay(r.doneOn) : undefined, state: (i < at ? 'done' : i === at ? 'current' : 'upcoming') as 'done' | 'current' | 'upcoming' }))
        if (r.status === 'cancelled') steps.push({ id: 'cancelled', label: 'Cancelled', hint: undefined, state: 'current' })
        return (
          <>
            <PageBar
              fallback="/services"
              label="Room services"
              actions={
                <>
                  {canEditRequest(r) && (
                    <Button variant="card" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                      <Pencil aria-hidden className="size-4" /> Edit
                    </Button>
                  )}
                  {(r.status === 'open' || r.status === 'in_progress') && (
                    <Button variant="card" loading={busy === 'cancel'} onClick={() => void run('cancel', `Cancelled ${r.number}`, () => service.transition(r.id, 'cancelled'))}>
                      <XCircle aria-hidden className="size-4" /> Cancel request
                    </Button>
                  )}
                  {r.charge > 0 && !r.transactionId && r.status === 'done' && (
                    <Button variant="card" loading={busy === 'charge'} onClick={() => void run('charge', `Recorded ${money(r.charge)}`, () => service.recordCharge(r.id), cashbox ? `Submitted on ${cashbox.name}` : undefined)}>
                      <Receipt aria-hidden className="size-4" /> Record charge
                    </Button>
                  )}
                  {step && (
                    <Button variant="accent" loading={busy === 'step'} onClick={() => void run('step', `${step === 'done' ? 'Closed' : 'Started'} ${r.number}`, () => service.transition(r.id, step))}>
                      {step === 'done' ? <Check aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />} {SERVICE_ACTION_LABEL[step]}
                    </Button>
                  )}
                </>
              }
            />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0 space-y-4">
                {editing && options.data && (
                  <Card as="div" aria-label="Edit request">
                    <p className="mb-4 text-lg font-semibold tracking-tight">Edit {r.number}</p>
                    <RequestForm
                      initial={r}
                      catalog={options.data.catalog}
                      inHouse={options.data.inHouse}
                      save={(input) => service.update(r.id, input)}
                      onDone={() => {
                        toast({ title: `Saved ${r.number}` })
                        setEditing(false)
                        resource.reload()
                      }}
                      onCancel={() => setEditing(false)}
                    />
                  </Card>
                )}
                <Card aria-label={r.number}>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">{r.number}</p>
                      <Headline className="mt-1">{SERVICE_KIND_LABEL[r.kind]}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        <Link to={`/property/units/${r.unitId}`} className="font-mono hover:underline">
                          {r.unitCode}
                        </Link>{' '}
                        · {r.place.villa.name}, {r.place.location.name} · {shortDay(r.requestedOn)} {clockLabel(r.requestedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {r.priority === 'urgent' && <Tag tone="accent">Urgent</Tag>}
                      <StatusPill tone={SERVICE_TONE[r.status]}>{SERVICE_STATUS_LABEL[r.status]}</StatusPill>
                    </div>
                  </div>
                  {r.note && <p className="mt-5 text-sm text-body">{r.note}</p>}
                  <FactGrid
                    className="mt-6 grid-cols-2 sm:grid-cols-3"
                    facts={[
                      ['Guest', r.booking ? <Link key="g" to={`/bookings/${r.booking.id}`} className="hover:underline">{r.booking.guestName}</Link> : 'Housekeeping'],
                      ['Charge', r.charge ? money(r.charge) : 'Included'],
                      ['Recorded', r.transactionId ? <Link key="t" to={`/finance/transactions/${r.transactionId}`} className="text-accent-text hover:underline">Cashbox entry</Link> : r.charge ? 'Not yet' : 'Nothing to record'],
                      ['Assigned to', r.assignee || 'Nobody yet'],
                      ['Requested', `${shortDay(r.requestedOn)} ${clockLabel(r.requestedAt)}`],
                      ['Closed', r.doneOn ? shortDay(r.doneOn) : 'Open'],
                    ]}
                  />
                </Card>
              </div>
              <div className="space-y-4">
                <Card aria-labelledby="rq-steps">
                  <CardHeader id="rq-steps" title="Progress" />
                  <Steps label="Request progress" steps={steps} />
                </Card>
                <Card aria-labelledby="rq-assign">
                  <CardHeader id="rq-assign" title="Who takes it" />
                  <form
                    onSubmit={(e: FormEvent<HTMLFormElement>) => {
                      e.preventDefault()
                      const who = String(new FormData(e.currentTarget).get('assignee') ?? '')
                      void run('assign', `Assigned ${r.number} to ${who.trim()}`, () => service.assign(r.id, who))
                    }}
                    className="space-y-3"
                  >
                    <Field label="Staff" htmlFor="rq-who" error={errors.assignee}>
                      <Input id="rq-who" name="assignee" defaultValue={r.assignee} placeholder="Wayan, Komang, Putu" icon={<UserRound className="size-4" />} />
                    </Field>
                    <Button type="submit" variant="solid" size="sm" loading={busy === 'assign'} disabled={r.status === 'done' || r.status === 'cancelled'}>
                      Save
                    </Button>
                  </form>
                </Card>
              </div>
            </div>
          </>
        )
      }}
    </Gate>
  )
}
