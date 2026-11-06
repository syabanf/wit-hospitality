import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import { Printer } from 'lucide-react'
import { handOverAmount } from '@/domain/cashier'
import { KIND_LABEL, TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL } from '@/domain/payment'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { Gate } from '../../ui/Gate'
import { PageBar } from '../../ui/PageBar'
import { fieldErrors } from '../../ui/fieldErrors'
import { useToast } from '../../ui/useToast'
import { ShiftFigures, ShiftStatusPill } from './DrawerCount'
import { differenceText } from './shiftText'
import { CloseShiftForm } from './ShiftForms'

/** Who signs a difference past the tolerance, with a note. */
function SignOffForm({ id, onDone }: { id: string; onDone: () => void }) {
  const { cashier } = useServices()
  const toast = useToast()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const s = await cashier.signOff(id, note)
      toast({ title: `Signed off ${s.number}`, description: 'The difference went for approval as a cash count adjustment.' })
      onDone()
    } catch (err) {
      setError(Object.values(fieldErrors(err))[0])
    } finally {
      setSaving(false)
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <Field label="Note" htmlFor="signoff-note" error={error}>
        <Textarea id="signoff-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Checked the slips with the cashier." />
      </Field>
      <Button type="submit" variant="accent" loading={saving}>
        Sign off the difference
      </Button>
    </form>
  )
}

/** Cash leaves the counted drawer for the safe or the bank as a cash transfer. */
function DropForm({ id, counted, targets, onDone }: { id: string; counted: number; targets: readonly { id: string; name: string }[]; onDone: () => void }) {
  const { cashier } = useServices()
  const toast = useToast()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    try {
      const s = await cashier.drop(id, { toAccountId: String(f.get('to')), amount: Number(f.get('amount')), note: String(f.get('note') ?? '') })
      toast({ title: `Dropped ${money(s.dropped)}`, description: 'The transfer waits for approval.' })
      onDone()
    } catch (err) {
      setError(Object.values(fieldErrors(err))[0])
    } finally {
      setSaving(false)
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <Field label="To" htmlFor="drop-to">
        <Select id="drop-to" name="to" className="w-full" options={targets.map((t) => ({ value: t.id, label: t.name }))} />
      </Field>
      <Field label="Amount, Rp" htmlFor="drop-amount" error={error}>
        <Input id="drop-amount" name="amount" type="number" inputMode="numeric" min={0} step={1000} defaultValue={counted} className="tabular" />
      </Field>
      <Field label="Note" htmlFor="drop-note">
        <Input id="drop-note" name="note" placeholder="Bank run, safe" />
      </Field>
      <Button type="submit" variant="solid" loading={saving} className="sm:col-span-3 sm:justify-self-start">
        Drop the cash
      </Button>
    </form>
  )
}

/** One cashier shift: its drawer, what it took, the count, the sign-off and where the cash went. */
export default function ShiftPage() {
  const { id = '' } = useParams()
  const { cashier } = useServices()
  const resource = useResource(`cashier.shift:${id}`, () => cashier.shift(id), { keepPrevious: false })
  return (
    <Gate resource={resource} what="shift" back={{ to: '/finance/shifts', label: 'Back to shifts' }}>
      {(d) => {
        const s = d.shift
        const free = s.counted !== null && !s.handedOverId && !s.dropTransactionId
        return (
          <div className="space-y-4">
            <PageBar
              fallback="/finance/shifts"
              label="Shifts"
              actions={
                <Link to={`/finance/shifts/${s.id}/report`} className={buttonStyles({ variant: 'card' })}>
                  <Printer aria-hidden className="size-4" /> Shift report
                </Link>
              }
            />
            <Card aria-labelledby="shift-head">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h1 id="shift-head" className="text-xl font-bold tracking-tight">
                    {s.number} · {s.accountName}
                    <span className="text-accent">.</span>
                  </h1>
                  <p className="text-sm text-muted">
                    {s.cashierName}, business date {s.businessDate}, opened {s.openedAt.slice(11, 16)}
                    {s.closedAt && `, counted ${s.closedAt.slice(11, 16)}`}
                  </p>
                </div>
                <ShiftStatusPill status={s.status} />
              </div>
              <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
                <ShiftFigures float={s.float} totals={s.totals} />
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">Counted</dt>
                    <dd className="tabular">{s.counted === null ? 'Not yet' : money(s.counted)}</dd>
                  </div>
                  <div className="flex justify-between gap-2 font-semibold">
                    <dt>Difference</dt>
                    <dd className={s.difference ? 'text-danger' : ''}>{differenceText(s.difference)}</dd>
                  </div>
                  {s.reason && <p className="text-muted">Reason: {s.reason}</p>}
                  {s.signOff && (
                    <p className="text-muted">
                      Signed off by {s.signOff.by}
                      {s.signOff.note && `: ${s.signOff.note}`}
                    </p>
                  )}
                  {d.handOverIn && <p className="text-muted">Float handed over from {d.handOverIn.shift?.number} ({d.handOverIn.from}).</p>}
                  {d.handOverOut && <p className="text-muted">Handed {money(d.handOverOut.amount)} over to {d.handOverOut.shift?.number} ({d.handOverOut.to}).</p>}
                  {d.drop && (
                    <p className="text-muted">
                      Dropped {money(s.dropped)} to {d.drop.to}, <Link to={`/finance/transactions/${d.drop.transaction.id}`} className="text-accent-text hover:underline">{d.drop.transaction.number}</Link>.
                    </p>
                  )}
                  {s.reconciliationId && <p className="text-muted">The count went to the books as a cash count on {s.accountName}.</p>}
                </dl>
              </div>
            </Card>

            {s.status === 'open' && d.canWork && (
              <Card aria-labelledby="close-shift">
                <CardHeader id="close-shift" title="Count and close" />
                <CloseShiftForm shift={s} policy={d.policy} onClosed={resource.reload} />
              </Card>
            )}
            {d.canSignOff && (
              <Card aria-labelledby="sign-off">
                <CardHeader id="sign-off" title={`Sign off: ${differenceText(s.difference)}`} />
                <SignOffForm id={s.id} onDone={resource.reload} />
              </Card>
            )}
            {free && d.canWork && (
              <Card aria-labelledby="drop">
                <CardHeader id="drop" title="Drop cash to the safe or the bank" />
                <p className="mb-3 text-sm text-muted">Or leave it in the drawer: the next cashier takes over {money(handOverAmount(s))} as their float when opening.</p>
                <DropForm id={s.id} counted={s.counted ?? 0} targets={d.dropTargets} onDone={resource.reload} />
              </Card>
            )}

            <Card aria-labelledby="shift-entries">
              <CardHeader id="shift-entries" title="Cash on the shift" />
              {d.entries.length === 0 ? (
                <p className="text-sm text-muted">Nothing recorded on the drawer yet.</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {d.entries.map((t) => (
                    <li key={t.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <Link to={`/finance/transactions/${t.id}`} className="min-w-0 hover:underline">
                        <span className="font-mono text-xs">{t.number}</span> · {t.description} <span className="text-muted">· {t.categoryName} · {TRANSACTION_STATUS_LABEL[t.status]}</span>
                      </Link>
                      <span className="tabular">{t.kind === 'cash_out' ? '-' : ''}{money(t.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {d.payments.length > 0 && (
              <Card aria-labelledby="shift-payments">
                <CardHeader id="shift-payments" title="Guest payments taken" />
                <ul className="divide-y divide-line text-sm">
                  {d.payments.map((p) => (
                    <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2">
                      <Link to={`/bookings/${p.bookingId}`} className="hover:underline">
                        <span className="font-mono text-xs">{p.number}</span> · {p.bookingCode} · {PAYMENT_KIND_LABEL[p.kind]} · {PAYMENT_METHOD_LABEL[p.method]}
                      </Link>
                      <span className="tabular">{p.kind === 'refund' ? '-' : ''}{money(p.amount)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {d.categories.length > 0 && (
              <Card aria-labelledby="shift-categories">
                <CardHeader id="shift-categories" title="By category" />
                <ul className="divide-y divide-line text-sm">
                  {d.categories.map((c) => (
                    <li key={`${c.kind}-${c.categoryId}`} className="flex justify-between gap-2 py-2">
                      <span>
                        {c.name} <span className="text-muted">· {KIND_LABEL[c.kind]} · {c.count}</span>
                      </span>
                      <span className="tabular">{money(c.amount)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )
      }}
    </Gate>
  )
}
