import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, UserRoundPlus } from 'lucide-react'
import { DEPARTMENT_LABEL, LEAVE_KIND_LABEL, LOAN_KIND_LABEL, REQUEST_STATUS_LABEL, type Department, type LeaveKind } from '@/domain/hr'
import { shortDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { seriesColor } from '../../charts/colors'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { useAccess } from '../../hooks/useAccess'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Select } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { ViewToggle } from '../../ui/ViewToggle'
import { REQUEST_TONE } from '../shared/tones'
import { BreakdownDonut } from './BreakdownDonut'
import { ATTENDANCE_SERIES, attendanceSlices } from './chartSeries'
import { DecideButtons } from './DecideButtons'
import { useFilters } from './useFilters'

/** People at a glance: who is in today, what waits for a decision, and how the team splits. */
export default function HrOverviewPage() {
  const { hr, clock } = useServices()
  const { can } = useAccess()
  const [layout, setLayout] = useLayout()
  const { values, set } = useFilters(['villa', 'from', 'to'] as const)
  const data = useResource(`hr.overview:${values.villa}|${values.from}|${values.to}`, () => hr.overview({ villaId: values.villa || undefined, from: values.from || undefined, to: values.to || undefined }))
  const [overtimeVilla, setOvertimeVilla] = useState<string | null>(null)
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const pending = d.pendingLeaves.length + d.pendingOvertime.length + d.pendingLoans.length
  const rangeLabel = `${shortDay(d.from)} to ${shortDay(d.to)}`
  const dayLabels = d.attendanceSeries.map((row) => shortDay(row.date).replace(/^\w+ /, ''))
  const leaveKinds = Object.entries(d.leaveByKind) as Array<[LeaveKind, number]>
  const leaveTotal = leaveKinds.reduce((s, [, days]) => s + days, 0)
  const overtimeTotal = d.overtimeByVilla.reduce((s, r) => s + r.hours, 0)
  const selectedOvertime = d.overtimeByVilla.find((r) => r.villa.id === overtimeVilla) ?? d.overtimeByVilla[0] ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Attendance today, requests waiting for a decision, and the team by department and villa.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} />
          {can('hr', 'create') && (
            <Link to="/hr/employees/new" className={buttonStyles({ variant: 'accent' })}>
              <UserRoundPlus aria-hidden className="size-4" /> New employee
            </Link>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Villa" tone="card" value={values.villa} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => set({ villa: e.target.value })} />
        <DateRangeFilter today={clock.today()} tone="card" label="Attendance" value={{ from: values.from || undefined, to: values.to || undefined }} onChange={(r) => set({ from: r.from ?? '', to: r.to ?? '' })} />
      </div>
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Employees" value={d.employees} hint={`${d.probation} on probation`} to="/hr/employees" />
        <StatTile label="Present today" value={d.presentToday} hint={`${d.lateToday} late`} to={`/hr/attendance?from=${d.today}&to=${d.today}`} />
        <StatTile label="Absent today" value={d.absentToday} hint={`${d.onLeaveToday} on leave`} to={`/hr/attendance?status=absent&from=${d.today}&to=${d.today}`} />
        <StatTile label="Pending requests" value={pending} hint="Leave, overtime, loans" to="/hr/leave?status=pending" />
        <StatTile label="Overtime this month" value={`${d.overtimeHoursMonth} h`} hint="Approved hours" to="/hr/overtime?status=approved" />
        <StatTile label="Payroll run-rate" value={money(d.payrollMonth)} hint="Basic plus allowances" to="/payroll" />
      </div>

      <div className="stagger grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card aria-labelledby="pending-leave">
          <CardHeader
            id="pending-leave"
            title="Leave waiting"
            action={
              <Link to="/hr/leave" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                All <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          />
          {d.pendingLeaves.length === 0 ? (
            <p className="text-sm text-muted">No leave requests wait.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.pendingLeaves.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {l.employeeName} · {LEAVE_KIND_LABEL[l.kind]}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {shortDay(l.from)} to {shortDay(l.to)} · {plural(l.days, 'day')} · {l.reason}
                    </p>
                  </div>
                  {can('hr', 'approve') ? <DecideButtons number={l.number} decide={(to, note) => hr.decideLeave(l.id, to, note)} onDone={data.reload} /> : <StatusPill tone={REQUEST_TONE[l.status]}>{REQUEST_STATUS_LABEL[l.status]}</StatusPill>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card aria-labelledby="pending-ot">
          <CardHeader
            id="pending-ot"
            title="Overtime and loans waiting"
            action={
              <Link to="/hr/overtime" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                All <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          />
          {d.pendingOvertime.length + d.pendingLoans.length === 0 ? (
            <p className="text-sm text-muted">Nothing waits.</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.pendingOvertime.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {o.employeeName} · {o.hours} h on {shortDay(o.date)}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {o.villaName} · {o.reason}
                    </p>
                  </div>
                  {can('hr', 'approve') ? <DecideButtons number={o.number} decide={(to, note) => hr.decideOvertime(o.id, to, note)} onDone={data.reload} /> : <StatusPill tone={REQUEST_TONE[o.status]}>{REQUEST_STATUS_LABEL[o.status]}</StatusPill>}
                </li>
              ))}
              {d.pendingLoans.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {l.employeeName} · {LOAN_KIND_LABEL[l.kind]} {money(l.amount)}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {plural(l.installments, 'instalment')} of {money(l.monthly)} · {l.reason}
                    </p>
                  </div>
                  {can('payroll', 'approve') ? <DecideButtons number={l.number} decide={(to, note) => hr.decideLoan(l.id, to, note)} onDone={data.reload} /> : <StatusPill tone={REQUEST_TONE.pending}>Pending</StatusPill>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="stagger grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" aria-labelledby="att-series">
          <CardHeader
            id="att-series"
            title={`Attendance per day, ${rangeLabel}`}
            action={
              <ul className="flex flex-wrap gap-3 text-xs text-muted">
                {ATTENDANCE_SERIES.map((s) => (
                  <li key={s.id} className="flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-full" style={{ background: s.color }} /> {s.label} {d.attendanceTotals[s.id]}
                  </li>
                ))}
              </ul>
            }
          />
          {layout === 'table' ? (
            <DataTable
              label="Attendance per day"
              rows={d.attendanceSeries}
              rowKey={(r) => r.date}
              columns={[
                { key: 'd', header: 'Day', cell: (r) => shortDay(r.date) },
                { key: 'p', header: 'Present', align: 'right', cell: (r) => r.present },
                { key: 'l', header: 'Late', align: 'right', cell: (r) => r.late },
                { key: 'a', header: 'Absent', align: 'right', cell: (r) => r.absent },
                { key: 'v', header: 'On leave', align: 'right', cell: (r) => r.leave },
              ]}
              footer={['Total', d.attendanceTotals.present, d.attendanceTotals.late, d.attendanceTotals.absent, d.attendanceTotals.leave]}
            />
          ) : (
            <GroupedColumns
              label="Attendance per day"
              className="h-56 lg:h-64"
              labels={dayLabels}
              series={ATTENDANCE_SERIES}
              values={ATTENDANCE_SERIES.map((s) => d.attendanceSeries.map((row) => row[s.id]))}
              format={String}
            />
          )}
        </Card>
        <Card aria-labelledby="by-dept">
          <CardHeader id="by-dept" title="Headcount by department" />
          <BreakdownDonut
            label="Headcount by department"
            stacked
            size={150}
            slices={d.byDepartment.map((row, i) => ({ id: row.department, label: DEPARTMENT_LABEL[row.department as Department] ?? row.department, value: row.count, color: seriesColor(i < 5 ? i + 1 : 0) }))}
            centre={d.employees}
          />
        </Card>
        <Card className="xl:col-span-2" aria-labelledby="ot-villa">
          <CardHeader id="ot-villa" title={`Overtime hours by villa, ${rangeLabel}`} action={selectedOvertime && <p className="text-xs text-muted">{selectedOvertime.villa.name}: {selectedOvertime.hours} of {overtimeTotal} h</p>} />
          {d.overtimeByVilla.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No approved overtime in the range.</p>
          ) : layout === 'table' ? (
            <DataTable label="Overtime hours by villa" rows={d.overtimeByVilla} rowKey={(r) => r.villa.id} columns={[{ key: 'v', header: 'Villa', cell: (r) => r.villa.name }, { key: 'h', header: 'Hours', align: 'right', cell: (r) => r.hours }]} footer={['Total', overtimeTotal]} />
          ) : (
            <ColumnChart
              label="Overtime hours by villa"
              className="h-48"
              data={d.overtimeByVilla.map((r) => ({ key: r.villa.id, label: r.villa.code, value: r.hours }))}
              selected={selectedOvertime?.villa.id ?? null}
              onSelect={setOvertimeVilla}
              format={(v) => `${v} h`}
              tick={(v) => `${v} h`}
            />
          )}
        </Card>
        <Card aria-labelledby="leave-kind">
          <CardHeader id="leave-kind" title="Leave days by kind" />
          {leaveTotal === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No leave touches the range.</p>
          ) : (
            <ul className="stagger space-y-2.5">
              {leaveKinds
                .sort((a, b) => b[1] - a[1])
                .map(([kind, days], i) => (
                  <li key={kind} className="text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate">{LEAVE_KIND_LABEL[kind]}</span>
                      <span className="shrink-0 tabular">{plural(days, 'day')}</span>
                    </div>
                    <span className="mt-1 block h-2 overflow-hidden rounded-full bg-raised">
                      <span className="block h-2 rounded-full transition-[width] duration-500" style={{ width: `${(days / leaveTotal) * 100}%`, background: seriesColor((i % 5) + 1) }} />
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </Card>
        <Card aria-labelledby="by-villa">
          <CardHeader id="by-villa" title="By villa" />
          <ul className="space-y-2">
            {d.byVilla.map((row) => (
              <li key={row.villa.id} className="flex items-center gap-3 text-sm">
                <Link to={`/hr/employees?villa=${row.villa.id}`} className="w-36 shrink-0 truncate hover:underline">
                  {row.villa.name}
                </Link>
                <span className="h-2 flex-1 rounded-full bg-raised">
                  <span className="block h-2 rounded-full bg-accent" style={{ width: `${(row.count / d.employees) * 100}%` }} />
                </span>
                <span className="w-6 text-right tabular">{row.count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">People who work at two villas count for both.</p>
        </Card>
        <Card className="xl:col-span-1" aria-labelledby="att-range">
          <CardHeader id="att-range" title={`Attendance, ${rangeLabel}`} />
          <BreakdownDonut label="Attendance in the range" stacked size={150} slices={attendanceSlices(d.attendanceTotals)} format={(v) => plural(v, 'day')} empty="No attendance recorded in the range." />
        </Card>
        <Card aria-labelledby="recent-leave">
          <CardHeader id="recent-leave" title="Latest leave" />
          <ul className="divide-y divide-line">
            {d.recentLeaves.map((l) => (
              <li key={l.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{l.employeeName}</span>
                  <span className="block truncate text-xs text-muted">
                    {LEAVE_KIND_LABEL[l.kind]} · {shortDay(l.from)} · {plural(l.days, 'day')}
                  </span>
                </span>
                <StatusPill tone={REQUEST_TONE[l.status]}>{REQUEST_STATUS_LABEL[l.status]}</StatusPill>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
