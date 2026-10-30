import { useState, type FormEvent } from 'react'
import { Plus, Search } from 'lucide-react'
import { REQUEST_STATUS_LABEL, REQUEST_STATUSES, type RequestStatus } from '@/domain/hr'
import { shortDay } from '@/lib/dates'
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
import { REQUEST_TONE } from '../shared/tones'
import { DecideButtons } from './DecideButtons'
import { useFilters } from './useFilters'

type StatusFilter = RequestStatus | 'all'
const CHIPS: StatusFilter[] = ['all', ...REQUEST_STATUSES]

export default function OvertimePage() {
  const { hr, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('hr.overtime', () => hr.overtime())
  const { values, set, clear, active } = useFilters(['status', 'employee', 'villa', 'q', 'from', 'to'] as const)
  const status = (CHIPS.find((c) => c === values.status) ?? 'all') as StatusFilter
  const [adding, setAdding] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const o = await hr.requestOvertime({ employeeId: String(f.get('employee') ?? ''), date: String(f.get('date') ?? ''), hours: Number(f.get('hours')), villaId: String(f.get('villa') ?? ''), reason: String(f.get('reason') ?? '') })
      toast({ title: `Requested ${o.number}`, description: `${o.hours} hours on ${shortDay(o.date)}` })
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
  const rows = hr.filter(d.rows, { status, employeeId: values.employee || undefined, villaId: values.villa || undefined, query: values.q, from: values.from || undefined, to: values.to || undefined }, (r) => r.date, (r) => r.villaId)
  const month = d.today.slice(0, 7)
  const approvedMonth = d.rows.filter((r) => r.status === 'approved' && r.date.startsWith(month))
  const approver = can('hr', 'approve')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Extra hours in half-hour steps, charged to the villa they were worked at. Approved hours are paid at the rate in the payroll settings.</p>
        {can('hr', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Request overtime
          </Button>
        )}
      </div>
      {adding && (
        <Card as="div" aria-label="Request overtime">
          <form onSubmit={(e) => void add(e)} className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <Field label="Employee" htmlFor="ot-emp" error={errors.employeeId} className="col-span-2">
              <Select id="ot-emp" name="employee" className="w-full" options={[{ value: '', label: 'Pick the employee' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} />
            </Field>
            <Field label="Date" htmlFor="ot-date" error={errors.date}>
              <Input id="ot-date" name="date" type="date" defaultValue={d.today} />
            </Field>
            <Field label="Hours" htmlFor="ot-hours" error={errors.hours}>
              <Input id="ot-hours" name="hours" type="number" inputMode="decimal" min={0.5} max={8} step={0.5} defaultValue={2} className="tabular" />
            </Field>
            <Field label="Villa" htmlFor="ot-villa" error={errors.villaId} className="col-span-2">
              <Select id="ot-villa" name="villa" className="w-full" options={[{ value: '', label: 'Pick the villa' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} />
            </Field>
            <Field label="Reason" htmlFor="ot-reason" error={errors.reason ?? errors.form} className="col-span-2 sm:col-span-3 xl:col-span-4">
              <Input id="ot-reason" name="reason" placeholder="Late arrival, double shift, repair" />
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
        <StatTile label="Approved this month" value={`${approvedMonth.reduce((s, r) => s + r.hours, 0)} h`} hint={`${approvedMonth.length} requests`} active={status === 'approved'} onClick={() => set({ status: status === 'approved' ? '' : 'approved' })} />
        <StatTile label="Rejected" value={d.rows.filter((r) => r.status === 'rejected').length} active={status === 'rejected'} onClick={() => set({ status: status === 'rejected' ? '' : 'rejected' })} />
        <StatTile label="Rate" value="1.5×" hint="Basic ÷ 173 per hour" to="/payroll/settings" />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : REQUEST_STATUS_LABEL[c], count: c === 'all' ? d.rows.length : d.rows.filter((r) => r.status === c).length }))}
          chip={status}
          onChip={(c) => set({ status: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.rows.length} requests`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Employee" aria-label="Search overtime" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Employee" value={values.employee} options={[{ value: '', label: 'Everyone' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} onChange={(e) => set({ employee: e.target.value })} />
              <Select aria-label="Villa" value={values.villa} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => set({ villa: e.target.value })} />
            </>
          }
          date={<DateRangeFilter today={d.today} label="Date" value={{ from: values.from || undefined, to: values.to || undefined }} onChange={(r) => set({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={active}
          onClear={clear}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="Overtime requests"
            rows={rows}
            rowKey={(r) => r.id}
            href={(r) => `/hr/employees/${r.employeeId}`}
            exportName="overtime"
            exportDate={clock.today()}
            empty={<EmptyState title="No request matches" action={<Button size="sm" variant="solid" onClick={clear}>Clear filters</Button>} />}
            columns={[
              { key: 'name', header: 'Employee', cell: (r) => r.employeeName, value: (r) => r.employeeName },
              { key: 'no', header: 'Number', cell: (r) => <span className="font-mono text-xs text-muted">{r.number}</span>, value: (r) => r.number, hide: 'xl' },
              { key: 'date', header: 'Date', cell: (r) => shortDay(r.date), value: (r) => r.date },
              { key: 'villa', header: 'Villa', cell: (r) => r.villaName, value: (r) => r.villaName, hide: 'lg' },
              { key: 'hours', header: 'Hours', align: 'right', cell: (r) => <span className="tabular">{r.hours}</span>, value: (r) => r.hours, total: (sum) => `${sum} h`, hide: 'lg' },
              { key: 'reason', header: 'Reason', cell: (r) => <span className="line-clamp-1 text-muted">{r.reason}</span>, value: (r) => r.reason, hide: 'xl' },
              { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={REQUEST_TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</StatusPill>, value: (r) => REQUEST_STATUS_LABEL[r.status] },
              { key: 'act', header: '', align: 'right', cell: (r) => (r.status === 'pending' && approver ? <DecideButtons compact number={r.number} decide={(to, note) => hr.decideOvertime(r.id, to, note)} onDone={data.reload} /> : r.decidedBy ? <span className="text-xs text-muted">{r.decidedBy}</span> : null) },
            ]}
            card={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.employeeName}</p>
                  <p className="text-xs text-muted">
                    {shortDay(r.date)} · {r.hours} h · {r.villaName}
                  </p>
                </div>
                <StatusPill tone={REQUEST_TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</StatusPill>
              </div>
            )}
          />
        </div>
      </Card>
    </div>
  )
}
