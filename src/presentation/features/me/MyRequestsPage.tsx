import { useState, type FormEvent } from 'react'
import { LEAVE_KIND_LABEL, LEAVE_KINDS, loanInstalment, LOAN_KIND_LABEL, LOAN_STATUS_LABEL, REQUEST_STATUS_LABEL, type LeaveKind, type LoanKind } from '@/domain/hr'
import { addMonths, shortDay, startOfMonth } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { Tabs } from '../../ui/Tabs'
import { useToast } from '../../ui/useToast'
import { DecideButtons } from '../hr/DecideButtons'
import { LOAN_TONE, REQUEST_TONE } from '../shared/tones'

type Kind = 'leave' | 'overtime' | 'loan'
const TABS = [
  { value: 'leave', label: 'Leave' },
  { value: 'overtime', label: 'Overtime' },
  { value: 'loan', label: 'Loan' },
] as const

/** Leave, overtime and loan requests from the employee, with the history and Cancel while pending. */
export default function MyRequestsPage() {
  const { people } = useServices()
  const toast = useToast()
  const data = useResource('people.home:requests', () => people.home())
  const [kind, setKind] = useState<Kind>('leave')
  const [loanKind, setLoanKind] = useState<LoanKind>('loan')
  const [amount, setAmount] = useState(1_000_000)
  const [installments, setInstallments] = useState(2)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    setSaving(true)
    setErrors({})
    try {
      if (kind === 'leave') {
        const l = await people.requestLeave({ kind: f.get('kind') as LeaveKind, from: String(f.get('from') ?? ''), to: String(f.get('to') ?? ''), reason: String(f.get('reason') ?? '') })
        toast({ title: `Requested ${l.number}`, description: `${plural(l.days, 'day')} waits for your manager` })
      } else if (kind === 'overtime') {
        const o = await people.requestOvertime({ date: String(f.get('date') ?? ''), hours: Number(f.get('hours')), villaId: String(f.get('villa') ?? ''), reason: String(f.get('reason') ?? '') })
        toast({ title: `Requested ${o.number}`, description: `${o.hours} hours wait for your manager` })
      } else {
        const l = await people.requestLoan({ kind: loanKind, amount, installments: loanKind === 'advance' ? 1 : installments, reason: String(f.get('reason') ?? ''), startMonth: String(f.get('startMonth') ?? '') })
        toast({ title: `Requested ${l.number}`, description: `${money(l.amount)} waits for finance` })
      }
      form.reset()
      data.reload()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  if (!d.employee) {
    return (
      <>
        <PageBar fallback="/me" label="My area" />
        <EmptyState title="This login is not linked to an employee record">Sign in as an employee to make requests.</EmptyState>
      </>
    )
  }
  const villas = d.employee.villas
  const nextMonth = addMonths(startOfMonth(d.today), 1).slice(0, 7)
  const cancel = (k: Kind, id: string, number: string) => <DecideButtons own number={number} decide={() => people.cancelRequest(k, id)} onDone={data.reload} />

  return (
    <>
      <PageBar fallback="/me" label="My area" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="req-title">
            <CardHeader id="req-title" title="New request" action={<Tabs label="Request kind" options={TABS} value={kind} onChange={(v) => { setKind(v); setErrors({}) }} />} />
            <form key={kind} onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {kind === 'leave' && (
                <>
                  <Field label="Kind" htmlFor="mr-kind" error={errors.kind} hint={`${plural(d.leaveLeft, 'annual day')} left`}>
                    <Select id="mr-kind" name="kind" className="w-full" options={LEAVE_KINDS.map((k) => ({ value: k, label: LEAVE_KIND_LABEL[k] }))} />
                  </Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="First day" htmlFor="mr-from" error={errors.from}>
                      <Input id="mr-from" name="from" type="date" defaultValue={d.today} />
                    </Field>
                    <Field label="Last day" htmlFor="mr-to" error={errors.to}>
                      <Input id="mr-to" name="to" type="date" defaultValue={d.today} />
                    </Field>
                  </div>
                </>
              )}
              {kind === 'overtime' && (
                <>
                  <Field label="Date" htmlFor="mr-date" error={errors.date}>
                    <Input id="mr-date" name="date" type="date" defaultValue={d.today} />
                  </Field>
                  <Field label="Hours" htmlFor="mr-hours" error={errors.hours} hint="Half-hour steps, up to 8">
                    <Input id="mr-hours" name="hours" type="number" inputMode="decimal" min={0.5} max={8} step={0.5} defaultValue={2} className="tabular" />
                  </Field>
                  <Field label="Villa" htmlFor="mr-villa" error={errors.villaId}>
                    <Select id="mr-villa" name="villa" className="w-full" options={villas.map((v) => ({ value: v.id, label: v.name }))} />
                  </Field>
                </>
              )}
              {kind === 'loan' && (
                <>
                  <Field label="Kind" htmlFor="mr-lkind">
                    <Select id="mr-lkind" className="w-full" value={loanKind} options={[{ value: 'loan', label: LOAN_KIND_LABEL.loan }, { value: 'advance', label: LOAN_KIND_LABEL.advance }]} onChange={(e) => setLoanKind(e.target.value as LoanKind)} />
                  </Field>
                  <Field label="Amount, Rp" htmlFor="mr-amount" error={errors.amount} hint={`Up to ${money(d.employee.basicSalary * 3)}`}>
                    <Input id="mr-amount" type="number" inputMode="numeric" min={0} step={100_000} className="tabular" value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} />
                  </Field>
                  <Field label="Months" htmlFor="mr-months" error={errors.installments} hint={loanKind === 'advance' ? 'Repaid from the next payroll' : `${money(loanInstalment(amount, installments))} a month`}>
                    <Input id="mr-months" type="number" inputMode="numeric" min={1} max={12} className="tabular" value={loanKind === 'advance' ? 1 : installments} disabled={loanKind === 'advance'} onChange={(e) => setInstallments(Number(e.target.value))} />
                  </Field>
                  <Field label="From month" htmlFor="mr-start" error={errors.startMonth}>
                    <Input id="mr-start" name="startMonth" type="month" defaultValue={nextMonth} />
                  </Field>
                </>
              )}
              <Field label="Reason" htmlFor="mr-reason" error={errors.reason ?? errors.form} className="sm:col-span-2">
                <Textarea id="mr-reason" name="reason" rows={2} />
              </Field>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" variant="accent" loading={saving}>
                  Send request
                </Button>
              </div>
            </form>
          </Card>
          <Card aria-labelledby="hist-leave">
            <CardHeader id="hist-leave" title="Leave" />
            {d.leaves.length === 0 ? (
              <p className="text-sm text-muted">No leave requested.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {d.leaves.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {LEAVE_KIND_LABEL[l.kind]} · {shortDay(l.from)} to {shortDay(l.to)} · {plural(l.days, 'day')}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {l.reason}
                        {l.decisionNote && ` · ${l.decisionNote}`}
                      </span>
                    </span>
                    <StatusPill tone={REQUEST_TONE[l.status]}>{REQUEST_STATUS_LABEL[l.status]}</StatusPill>
                    {l.status === 'pending' && cancel('leave', l.id, l.number)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card aria-labelledby="hist-ot">
            <CardHeader id="hist-ot" title="Overtime" />
            {d.overtime.length === 0 ? (
              <p className="text-sm text-muted">No overtime requested.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {d.overtime.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {o.hours} h on {shortDay(o.date)} · {o.villaName}
                      </span>
                      <span className="block truncate text-xs text-muted">{o.reason}</span>
                    </span>
                    <StatusPill tone={REQUEST_TONE[o.status]}>{REQUEST_STATUS_LABEL[o.status]}</StatusPill>
                    {o.status === 'pending' && cancel('overtime', o.id, o.number)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-4">
          <Card aria-labelledby="hist-loan">
            <CardHeader id="hist-loan" title="Loans" />
            {d.loans.length === 0 ? (
              <p className="text-sm text-muted">No loans.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {d.loans.map((l) => (
                  <li key={l.id} className="py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate">
                        {LOAN_KIND_LABEL[l.kind]} {money(l.amount)}
                      </span>
                      <StatusPill tone={LOAN_TONE[l.status]}>{LOAN_STATUS_LABEL[l.status]}</StatusPill>
                    </div>
                    <p className="text-xs text-muted">
                      {money(l.monthly)} a month from {l.startMonth} · {money(l.outstanding)} left
                    </p>
                    {l.status === 'pending' && <div className="mt-2">{cancel('loan', l.id, l.number)}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <p className="text-xs text-muted">Leave goes to your villa manager, overtime to your manager, loans to finance. A pending request can be cancelled; a decided one stays on record.</p>
        </div>
      </div>
    </>
  )
}
