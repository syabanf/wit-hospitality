import { useState, type FormEvent } from 'react'
import { Plus, Search } from 'lucide-react'
import { loanInstalment, LOAN_KIND_LABEL, LOAN_STATUS_LABEL, type LoanKind, type LoanStatus } from '@/domain/hr'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { LOAN_TONE } from '../shared/tones'
import { DecideButtons } from './DecideButtons'
import { useFilters } from './useFilters'

type StatusFilter = LoanStatus | 'all'
const CHIPS: StatusFilter[] = ['all', 'pending', 'active', 'settled', 'rejected', 'cancelled']

export default function LoansPage() {
  const { hr, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('hr.loans', () => hr.loans())
  const { values, set, clear, active } = useFilters(['status', 'employee', 'q', 'from', 'to'] as const)
  const status = (CHIPS.find((c) => c === values.status) ?? 'all') as StatusFilter
  const [adding, setAdding] = useState(false)
  const [amount, setAmount] = useState(2_000_000)
  const [installments, setInstallments] = useState(4)
  const [kind, setKind] = useState<LoanKind>('loan')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const l = await hr.requestLoan({ employeeId: String(f.get('employee') ?? ''), kind, amount, installments: kind === 'advance' ? 1 : installments, reason: String(f.get('reason') ?? ''), startMonth: String(f.get('startMonth') ?? '') })
      toast({ title: `Requested ${l.number}`, description: `${money(l.amount)} over ${plural(l.installments, 'month')}` })
      setAdding(false)
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
  const rows = hr.filter(d.rows, { status, employeeId: values.employee || undefined, query: values.q, from: values.from || undefined, to: values.to || undefined }, (r) => r.requestedOn)
  const open = d.rows.filter((r) => r.status === 'active')
  const approver = can('payroll', 'approve')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Loans and salary advances, repaid through payroll in equal monthly instalments from the start month. At most three months of basic salary, one open loan per person.</p>
        {can('hr', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Request loan
          </Button>
        )}
      </div>
      {adding && (
        <Card as="div" aria-label="Request a loan">
          <form onSubmit={(e) => void add(e)} className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <Field label="Employee" htmlFor="ln-emp" error={errors.employeeId} className="col-span-2">
              <Select id="ln-emp" name="employee" className="w-full" options={[{ value: '', label: 'Pick the employee' }, ...d.employees.map((e) => ({ value: e.id, label: `${e.name} · basic ${money(e.basicSalary)}` }))]} />
            </Field>
            <Field label="Kind" htmlFor="ln-kind">
              <Select id="ln-kind" className="w-full" value={kind} options={[{ value: 'loan', label: LOAN_KIND_LABEL.loan }, { value: 'advance', label: LOAN_KIND_LABEL.advance }]} onChange={(e) => setKind(e.target.value as LoanKind)} />
            </Field>
            <Field label="Amount, Rp" htmlFor="ln-amount" error={errors.amount}>
              <Input id="ln-amount" type="number" inputMode="numeric" min={0} step={100_000} className="tabular" value={amount || ''} onChange={(e) => setAmount(Number(e.target.value))} />
            </Field>
            <Field label="Months" htmlFor="ln-months" error={errors.installments} hint={kind === 'advance' ? 'An advance repays next payroll' : `${money(loanInstalment(amount, installments))} a month`}>
              <Input id="ln-months" type="number" inputMode="numeric" min={1} max={12} className="tabular" value={kind === 'advance' ? 1 : installments} disabled={kind === 'advance'} onChange={(e) => setInstallments(Number(e.target.value))} />
            </Field>
            <Field label="From month" htmlFor="ln-start" error={errors.startMonth}>
              <Input id="ln-start" name="startMonth" type="month" defaultValue={d.nextMonth} />
            </Field>
            <Field label="Reason" htmlFor="ln-reason" error={errors.reason ?? errors.form} className="col-span-2 sm:col-span-3 xl:col-span-4">
              <Input id="ln-reason" name="reason" placeholder="School fees, motorbike repair" />
            </Field>
            <div className="col-span-2 flex items-end gap-2">
              <Button type="submit" variant="accent" loading={saving}>
                Submit
              </Button>
              <Button variant="soft" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Pending" value={d.rows.filter((r) => r.status === 'pending').length} active={status === 'pending'} onClick={() => set({ status: status === 'pending' ? '' : 'pending' })} />
        <StatTile label="Repaying" value={open.length} hint={`${money(open.reduce((s, r) => s + r.outstanding, 0))} outstanding`} active={status === 'active'} onClick={() => set({ status: status === 'active' ? '' : 'active' })} />
        <StatTile label="Deducted next payroll" value={money(open.reduce((s, r) => s + Math.min(r.monthly, r.outstanding), 0))} to="/payroll" />
        <StatTile label="Settled" value={d.rows.filter((r) => r.status === 'settled').length} active={status === 'settled'} onClick={() => set({ status: status === 'settled' ? '' : 'settled' })} />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : LOAN_STATUS_LABEL[c], count: c === 'all' ? d.rows.length : d.rows.filter((r) => r.status === c).length }))}
          chip={status}
          onChip={(c) => set({ status: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.rows.length} loans`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Employee" aria-label="Search loans" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
          filters={<Select aria-label="Employee" value={values.employee} options={[{ value: '', label: 'Everyone' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} onChange={(e) => set({ employee: e.target.value })} />}
          date={<DateRangeFilter today={d.today} label="Requested" value={{ from: values.from || undefined, to: values.to || undefined }} onChange={(r) => set({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={active}
          onClear={clear}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="Loans"
            rows={rows}
            rowKey={(r) => r.id}
            href={(r) => `/hr/employees/${r.employeeId}`}
            exportName="loans"
            exportDate={clock.today()}
            empty={<EmptyState title="No loan matches" action={<Button size="sm" variant="solid" onClick={clear}>Clear filters</Button>} />}
            columns={[
              { key: 'name', header: 'Employee', cell: (r) => r.employeeName, value: (r) => r.employeeName },
              { key: 'no', header: 'Number', cell: (r) => <span className="font-mono text-xs text-muted">{r.number}</span>, value: (r) => r.number, hide: 'xl' },
              { key: 'kind', header: 'Kind', cell: (r) => LOAN_KIND_LABEL[r.kind], value: (r) => LOAN_KIND_LABEL[r.kind], hide: 'lg' },
              { key: 'req', header: 'Requested', cell: (r) => shortDay(r.requestedOn), value: (r) => r.requestedOn, hide: 'lg' },
              { key: 'amount', header: 'Amount', align: 'right', cell: (r) => <span className="tabular">{money(r.amount)}</span>, value: (r) => r.amount, total: (sum) => money(sum) },
              { key: 'monthly', header: 'Monthly', align: 'right', cell: (r) => <span className="tabular">{money(r.monthly)}</span>, value: (r) => r.monthly, hide: 'lg' },
              { key: 'left', header: 'Outstanding', align: 'right', cell: (r) => <span className="tabular">{money(r.outstanding)}</span>, value: (r) => r.outstanding, total: (sum) => money(sum), hide: 'lg' },
              { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={LOAN_TONE[r.status]}>{LOAN_STATUS_LABEL[r.status]}</StatusPill>, value: (r) => LOAN_STATUS_LABEL[r.status] },
              { key: 'act', header: '', align: 'right', cell: (r) => (r.status === 'pending' && approver ? <DecideButtons compact number={r.number} decide={(to, note) => hr.decideLoan(r.id, to, note)} onDone={data.reload} /> : r.decidedBy ? <span className="text-xs text-muted">{r.decidedBy}</span> : null) },
            ]}
            card={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.employeeName}</p>
                  <p className="text-xs text-muted">
                    {LOAN_KIND_LABEL[r.kind]} {money(r.amount)} · {money(r.outstanding)} left
                  </p>
                </div>
                <StatusPill tone={LOAN_TONE[r.status]}>{LOAN_STATUS_LABEL[r.status]}</StatusPill>
              </div>
            )}
          />
        </div>
      </Card>
    </div>
  )
}
