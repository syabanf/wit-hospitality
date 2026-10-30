import { useState, type FormEvent } from 'react'
import { Plus, Search } from 'lucide-react'
import { LEAVE_KIND_LABEL, LEAVE_KINDS, REQUEST_STATUS_LABEL, REQUEST_STATUSES, type LeaveKind, type RequestStatus } from '@/domain/hr'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { Field, Textarea } from '../../ui/Form'
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

export default function LeavePage() {
  const { hr, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('hr.leaves', () => hr.leaves())
  const { values, set, clear, active } = useFilters(['status', 'employee', 'q', 'from', 'to'] as const)
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
      const l = await hr.requestLeave({ employeeId: String(f.get('employee') ?? ''), kind: f.get('kind') as LeaveKind, from: String(f.get('from') ?? ''), to: String(f.get('to') ?? ''), reason: String(f.get('reason') ?? '') })
      toast({ title: `Requested ${l.number}`, description: `${plural(l.days, 'day')} of ${LEAVE_KIND_LABEL[l.kind].toLowerCase()}` })
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
  const rows = hr.filter(d.rows, { status, employeeId: values.employee || undefined, query: values.q, from: values.from || undefined, to: values.to || undefined }, (r) => r.from)
  const pending = d.rows.filter((r) => r.status === 'pending')
  const approver = can('hr', 'approve')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Annual, sick, permission and unpaid leave. Annual leave is checked against the days left this year; approved days land in attendance.</p>
        {can('hr', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Request leave
          </Button>
        )}
      </div>
      {adding && (
        <Card as="div" aria-label="Request leave">
          <form onSubmit={(e) => void add(e)} className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Field label="Employee" htmlFor="lv-emp" error={errors.employeeId}>
              <Select id="lv-emp" name="employee" className="w-full" options={[{ value: '', label: 'Pick the employee' }, ...d.employees.map((e) => ({ value: e.id, label: `${e.name} · ${e.leaveLeft} days left` }))]} />
            </Field>
            <Field label="Kind" htmlFor="lv-kind" error={errors.kind}>
              <Select id="lv-kind" name="kind" className="w-full" options={LEAVE_KINDS.map((k) => ({ value: k, label: LEAVE_KIND_LABEL[k] }))} />
            </Field>
            <Field label="First day" htmlFor="lv-from" error={errors.from}>
              <Input id="lv-from" name="from" type="date" defaultValue={d.today} />
            </Field>
            <Field label="Last day" htmlFor="lv-to" error={errors.to}>
              <Input id="lv-to" name="to" type="date" defaultValue={d.today} />
            </Field>
            <Field label="Reason" htmlFor="lv-reason" error={errors.reason ?? errors.form} className="sm:col-span-2 xl:col-span-3">
              <Textarea id="lv-reason" name="reason" rows={2} />
            </Field>
            <div className="flex items-end gap-2">
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
        <StatTile label="Pending" value={pending.length} hint={`${plural(pending.reduce((s, r) => s + r.days, 0), 'day')} asked`} active={status === 'pending'} onClick={() => set({ status: status === 'pending' ? '' : 'pending' })} />
        <StatTile label="Approved" value={d.rows.filter((r) => r.status === 'approved').length} active={status === 'approved'} onClick={() => set({ status: status === 'approved' ? '' : 'approved' })} />
        <StatTile label="On leave today" value={d.rows.filter((r) => r.status === 'approved' && r.from <= d.today && d.today <= r.to).length} to={`/hr/attendance?status=leave&from=${d.today}&to=${d.today}`} />
        <StatTile label="Sick days, this year" value={d.rows.filter((r) => r.kind === 'sick' && r.status === 'approved' && r.from.startsWith(d.today.slice(0, 4))).reduce((s, r) => s + r.days, 0)} onClick={() => set({ status: 'approved' })} />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : REQUEST_STATUS_LABEL[c], count: c === 'all' ? d.rows.length : d.rows.filter((r) => r.status === c).length }))}
          chip={status}
          onChip={(c) => set({ status: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.rows.length} requests`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Employee" aria-label="Search leave" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
          filters={<Select aria-label="Employee" value={values.employee} options={[{ value: '', label: 'Everyone' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} onChange={(e) => set({ employee: e.target.value })} />}
          date={<DateRangeFilter today={d.today} label="First day" value={{ from: values.from || undefined, to: values.to || undefined }} onChange={(r) => set({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={active}
          onClear={clear}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="Leave requests"
            rows={rows}
            rowKey={(r) => r.id}
            href={(r) => `/hr/employees/${r.employeeId}`}
            exportName="leave"
            exportDate={clock.today()}
            empty={<EmptyState title="No request matches" action={<Button size="sm" variant="solid" onClick={clear}>Clear filters</Button>} />}
            columns={[
              { key: 'name', header: 'Employee', cell: (r) => r.employeeName, value: (r) => r.employeeName },
              { key: 'no', header: 'Number', cell: (r) => <span className="font-mono text-xs text-muted">{r.number}</span>, value: (r) => r.number, hide: 'xl' },
              { key: 'kind', header: 'Kind', cell: (r) => LEAVE_KIND_LABEL[r.kind], value: (r) => LEAVE_KIND_LABEL[r.kind], hide: 'lg' },
              { key: 'from', header: 'From', cell: (r) => shortDay(r.from), value: (r) => r.from },
              { key: 'to', header: 'To', cell: (r) => shortDay(r.to), value: (r) => r.to, hide: 'lg' },
              { key: 'days', header: 'Days', align: 'right', cell: (r) => <span className="tabular">{r.days}</span>, value: (r) => r.days, total: (sum) => sum, hide: 'lg' },
              { key: 'reason', header: 'Reason', cell: (r) => <span className="line-clamp-1 text-muted">{r.reason}</span>, value: (r) => r.reason, hide: 'xl' },
              { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={REQUEST_TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</StatusPill>, value: (r) => REQUEST_STATUS_LABEL[r.status] },
              { key: 'act', header: '', align: 'right', cell: (r) => (r.status === 'pending' && approver ? <DecideButtons compact number={r.number} decide={(to, note) => hr.decideLeave(r.id, to, note)} onDone={data.reload} /> : r.decidedBy ? <span className="text-xs text-muted">{r.decidedBy}</span> : null) },
            ]}
            card={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.employeeName}</p>
                  <p className="text-xs text-muted">
                    {LEAVE_KIND_LABEL[r.kind]} · {shortDay(r.from)} to {shortDay(r.to)} · {plural(r.days, 'day')}
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
