import { useState, type FormEvent } from 'react'
import { Plus, Search } from 'lucide-react'
import { ATTENDANCE_STATUS_LABEL, ATTENDANCE_STATUSES, type AttendanceStatus } from '@/domain/hr'
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
import { ATTENDANCE_TONE } from '../shared/tones'
import { useFilters } from './useFilters'

type StatusFilter = AttendanceStatus | 'all'
const CHIPS: StatusFilter[] = ['all', ...ATTENDANCE_STATUSES]

export default function AttendancePage() {
  const { hr, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('hr.attendance', () => hr.attendance())
  const { values, set, clear, active } = useFilters(['status', 'employee', 'q', 'from', 'to'] as const)
  const status = (CHIPS.find((c) => c === values.status) ?? 'all') as StatusFilter
  const [recording, setRecording] = useState(false)
  const [formStatus, setFormStatus] = useState<AttendanceStatus>('present')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function record(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const r = await hr.recordAttendance({
        employeeId: String(f.get('employee') ?? ''),
        date: String(f.get('date') ?? ''),
        status: formStatus,
        clockIn: String(f.get('clockIn') ?? '') || null,
        clockOut: String(f.get('clockOut') ?? '') || null,
        note: String(f.get('note') ?? ''),
      })
      toast({ title: 'Attendance recorded', description: `${ATTENDANCE_STATUS_LABEL[r.status]} on ${shortDay(r.date)}` })
      setRecording(false)
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
  const rows = hr.filter(d.rows, { status, employeeId: values.employee || undefined, query: values.q, from: values.from || undefined, to: values.to || undefined }, (r) => r.date)
  const todays = d.rows.filter((r) => r.date === d.today)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Clock-in and clock-out per person per day. Minutes late count against the shift start and feed the payroll deduction.</p>
        {can('hr', 'edit') && (
          <Button variant="accent" aria-pressed={recording} onClick={() => setRecording((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Record attendance
          </Button>
        )}
      </div>
      {recording && (
        <Card as="div" aria-label="Record attendance">
          <form onSubmit={(e) => void record(e)} className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
            <Field label="Employee" htmlFor="at-emp" error={errors.employeeId} className="col-span-2">
              <Select id="at-emp" name="employee" className="w-full" options={[{ value: '', label: 'Pick the employee' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} />
            </Field>
            <Field label="Date" htmlFor="at-date" error={errors.date}>
              <Input id="at-date" name="date" type="date" defaultValue={d.today} max={d.today} />
            </Field>
            <Field label="Status" htmlFor="at-status" error={errors.status}>
              <Select id="at-status" className="w-full" value={formStatus} options={ATTENDANCE_STATUSES.map((s) => ({ value: s, label: ATTENDANCE_STATUS_LABEL[s] }))} onChange={(e) => setFormStatus(e.target.value as AttendanceStatus)} />
            </Field>
            <Field label="Clock in" htmlFor="at-in" error={errors.clockIn}>
              <Input id="at-in" name="clockIn" type="time" disabled={formStatus !== 'present' && formStatus !== 'late'} />
            </Field>
            <Field label="Clock out" htmlFor="at-out" error={errors.clockOut}>
              <Input id="at-out" name="clockOut" type="time" disabled={formStatus !== 'present' && formStatus !== 'late'} />
            </Field>
            <Field label="Note" htmlFor="at-note" className="col-span-2 sm:col-span-3 xl:col-span-4">
              <Input id="at-note" name="note" placeholder="Doctor’s note, bike trouble, swapped with…" />
            </Field>
            {errors.form && <p role="alert" className="col-span-full text-xs font-medium text-danger">{errors.form}</p>}
            <div className="col-span-2 flex items-end gap-2">
              <Button type="submit" variant="accent" loading={saving}>
                Save
              </Button>
              <Button variant="soft" onClick={() => setRecording(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
      <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Present today" value={todays.filter((r) => r.status === 'present' || r.status === 'late').length} hint={`of ${d.employees.length} active`} onClick={() => set({ from: d.today, to: d.today, status: '' })} active={values.from === d.today && values.to === d.today && status === 'all'} />
        <StatTile label="Late today" value={todays.filter((r) => r.status === 'late').length} onClick={() => set({ from: d.today, to: d.today, status: 'late' })} active={values.from === d.today && status === 'late'} />
        <StatTile label="Absent today" value={todays.filter((r) => r.status === 'absent').length} onClick={() => set({ from: d.today, to: d.today, status: 'absent' })} active={values.from === d.today && status === 'absent'} />
        <StatTile label="On leave today" value={todays.filter((r) => r.status === 'leave').length} to="/hr/leave?status=approved" />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : ATTENDANCE_STATUS_LABEL[c], count: c === 'all' ? d.rows.length : d.rows.filter((r) => r.status === c).length }))}
          chip={status}
          onChip={(c) => set({ status: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.rows.length} records`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Employee" aria-label="Search attendance" value={values.q} onChange={(e) => set({ q: e.target.value })} />}
          filters={<Select aria-label="Employee" value={values.employee} options={[{ value: '', label: 'Everyone' }, ...d.employees.map((e) => ({ value: e.id, label: e.name }))]} onChange={(e) => set({ employee: e.target.value })} />}
          date={<DateRangeFilter today={d.today} label="Date" value={{ from: values.from || undefined, to: values.to || undefined }} onChange={(r) => set({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={active}
          onClear={clear}
        />
        <ListTable
          label="Attendance"
          rows={rows}
          rowKey={(r) => r.id}
          href={(r) => `/hr/employees/${r.employeeId}`}
          defaultSort={{ key: 'date', dir: 'desc' }}
          exportName="attendance"
          exportDate={clock.today()}
          empty={<EmptyState title="No record matches" action={<Button size="sm" variant="solid" onClick={clear}>Clear filters</Button>} />}
          columns={[
            { key: 'name', header: 'Employee', cell: (r) => r.employeeName, value: (r) => r.employeeName },
            { key: 'date', header: 'Date', cell: (r) => shortDay(r.date), value: (r) => r.date },
            { key: 'shift', header: 'Shift', cell: (r) => (r.shift ? `${r.shift.name} ${r.shift.start}` : 'Off'), value: (r) => r.shift?.name ?? '', hide: 'lg' },
            { key: 'in', header: 'In', cell: (r) => <span className="tabular">{r.clockIn ?? ''}</span>, value: (r) => r.clockIn ?? '', hide: 'lg' },
            { key: 'out', header: 'Out', cell: (r) => <span className="tabular">{r.clockOut ?? ''}</span>, value: (r) => r.clockOut ?? '', hide: 'xl' },
            { key: 'late', header: 'Minutes late', align: 'right', cell: (r) => <span className="tabular">{r.lateMinutes || ''}</span>, value: (r) => r.lateMinutes, total: (sum) => sum },
            { key: 'status', header: 'Status', cell: (r) => <StatusPill tone={ATTENDANCE_TONE[r.status]}>{ATTENDANCE_STATUS_LABEL[r.status]}</StatusPill>, value: (r) => ATTENDANCE_STATUS_LABEL[r.status] },
            { key: 'note', header: 'Note', cell: (r) => <span className="line-clamp-1 text-muted">{r.note}</span>, value: (r) => r.note, hide: 'xl' },
          ]}
          card={(r) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.employeeName}</p>
                <p className="text-xs text-muted">
                  {shortDay(r.date)} · {r.clockIn ? `${r.clockIn} to ${r.clockOut ?? '…'}` : r.shift?.name ?? 'Off'}
                  {r.lateMinutes > 0 && ` · ${r.lateMinutes} min late`}
                </p>
              </div>
              <StatusPill tone={ATTENDANCE_TONE[r.status]}>{ATTENDANCE_STATUS_LABEL[r.status]}</StatusPill>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
