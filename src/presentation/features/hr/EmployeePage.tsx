import { Link, useParams } from 'react-router'
import { Pencil } from 'lucide-react'
import { ATTENDANCE_STATUS_LABEL, DEPARTMENT_LABEL, EMPLOYEE_STATUS_LABEL, LEAVE_KIND_LABEL, LOAN_KIND_LABEL, LOAN_STATUS_LABEL, REQUEST_STATUS_LABEL, type Department } from '@/domain/hr'
import { PAYROLL_STATUS_LABEL } from '@/domain/payroll'
import { kpiBand, KPI_BAND_LABEL } from '@/domain/people'
import { cn } from '@/lib/cn'
import { shortDay, weekdayDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { ScoreMeter } from '../../charts/ScoreMeter'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Avatar } from '../../ui/Avatar'
import { StatusPill, Tag } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { PageBar } from '../../ui/PageBar'
import { ATTENDANCE_TONE, EMPLOYEE_TONE, KPI_TONE, LOAN_TONE, PAYROLL_TONE, REQUEST_TONE } from '../shared/tones'
import { BreakdownDonut } from './BreakdownDonut'
import { attendanceSlices } from './chartSeries'

export default function EmployeePage() {
  const { id = '' } = useParams()
  const { hr } = useServices()
  const { can } = useAccess()
  const resource = useResource(`hr.employee:${id}`, () => hr.employee(id), { keepPrevious: false })

  return (
    <Gate resource={resource} what="employee" back={{ to: '/hr/employees', label: 'Back to employees' }}>
      {({ employee: e, attendance, attendanceSummary: a, roster, leaves, overtime, loans, payslips, kpis, today }) => (
        <>
          <PageBar
            fallback="/hr/employees"
            label="Employees"
            actions={
              can('hr', 'edit') && (
                <Link to={`/hr/employees/${e.id}/edit`} className={buttonStyles({ variant: 'accent' })}>
                  <Pencil aria-hidden className="size-4" /> Edit
                </Link>
              )
            }
          />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <div className="min-w-0 space-y-4">
              <Card aria-label={e.name}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-4">
                    <Avatar name={e.name} size="lg" />
                    <div className="min-w-0">
                      <p className="font-mono text-xs text-muted">{e.code}</p>
                      <Headline>{e.name}</Headline>
                      <p className="mt-1 text-sm text-muted">
                        {e.position} · {DEPARTMENT_LABEL[e.department as Department]}
                      </p>
                    </div>
                  </div>
                  <StatusPill tone={EMPLOYEE_TONE[e.status]}>{EMPLOYEE_STATUS_LABEL[e.status]}</StatusPill>
                </div>
                <FactGrid
                  className="mt-6 grid-cols-2 sm:grid-cols-3"
                  facts={[
                    ['Villas', e.allocations.map((al) => `${e.villas.find((v) => v.id === al.villaId)?.name ?? al.villaId} ${al.percent}%`).join(', ')],
                    ['Joined', `${shortDay(e.joinedOn)} · ${plural(e.tenureMonths, 'month')}`],
                    ['Basic salary', money(e.basicSalary)],
                    ['Allowances', e.allowances.map((x) => `${x.name} ${money(x.amount)}`).join(', ') || 'None'],
                    ['Leave left', plural(e.leaveLeft, 'day')],
                    ['Bank', e.bankName ? `${e.bankName} ${e.bankAccount}` : 'Not on file'],
                    ['Phone', e.phone || 'Not on file'],
                    ['Email', e.email || 'Not on file'],
                    ['Statutory', `${e.bpjsEnrolled ? 'BPJS' : 'No BPJS'}${e.npwp ? ` · NPWP ${e.npwp}` : ' · no NPWP'}${e.serviceChargeEligible ? ' · service charge' : ''}`],
                  ]}
                />
              </Card>

              <Card aria-labelledby="att-title">
                <CardHeader id="att-title" title="Attendance, last 30 days" action={<Link to={`/hr/attendance?employee=${e.id}`} className="text-sm text-accent-text hover:underline">All</Link>} />
                <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                  <BreakdownDonut label="Attendance, last 30 days" size={140} slices={attendanceSlices(a)} format={(v) => plural(v, 'day')} empty="No attendance in the last 30 days." />
                  <div className="stagger grid grid-cols-2 gap-2">
                    {(
                      [
                        ['Present', a.present],
                        ['Late', a.late],
                        ['Absent', a.absent],
                        ['Minutes late', a.lateMinutes],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="rounded-panel bg-raised p-3">
                        <p className="text-xs text-muted">{label}</p>
                        <p className="mt-1 text-xl font-medium tabular">{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <ul className="divide-y divide-line">
                  {attendance.slice(0, 8).map((r) => (
                    <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                      <span className="w-16 shrink-0 text-xs text-muted">{shortDay(r.date)}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {r.clockIn ? `${r.clockIn} to ${r.clockOut ?? '…'}` : r.shift ? r.shift.name : 'No shift'}
                        {r.note && <span className="text-muted"> · {r.note}</span>}
                      </span>
                      <StatusPill tone={ATTENDANCE_TONE[r.status]}>{ATTENDANCE_STATUS_LABEL[r.status]}</StatusPill>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card aria-labelledby="roster-title">
                <CardHeader id="roster-title" title="Roster, two weeks" action={<Link to={`/hr/roster?from=${today}`} className="text-sm text-accent-text hover:underline">Open roster</Link>} />
                <ul className="grid grid-cols-7 gap-1.5">
                  {roster.map((day) => (
                    <li key={day.date} className={cn('rounded-panel p-2 text-center text-xs', day.date === today && 'ring-2 ring-accent', day.shift ? 'bg-invert text-on-invert' : 'bg-raised text-muted')}>
                      <span className="block">{weekdayDay(day.date)}</span>
                      <span className="mt-1 block truncate font-medium">{day.shift ? day.shift.name : day.assignment ? 'Off' : '·'}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <div className="stagger grid grid-cols-1 gap-4 md:grid-cols-2">
                <Card aria-labelledby="leave-title">
                  <CardHeader id="leave-title" title="Leave" />
                  {leaves.length === 0 ? (
                    <p className="text-sm text-muted">No leave requested.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {leaves.slice(0, 6).map((l) => (
                        <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {LEAVE_KIND_LABEL[l.kind]} · {plural(l.days, 'day')}
                            </span>
                            <span className="block truncate text-xs text-muted">
                              {shortDay(l.from)} to {shortDay(l.to)}
                            </span>
                          </span>
                          <StatusPill tone={REQUEST_TONE[l.status]}>{REQUEST_STATUS_LABEL[l.status]}</StatusPill>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
                <Card aria-labelledby="ot-title">
                  <CardHeader id="ot-title" title="Overtime" />
                  {overtime.length === 0 ? (
                    <p className="text-sm text-muted">No overtime requested.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {overtime.slice(0, 6).map((o) => (
                        <li key={o.id} className="flex items-center gap-3 py-2 text-sm">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">
                              {o.hours} h · {o.villaName}
                            </span>
                            <span className="block truncate text-xs text-muted">
                              {shortDay(o.date)} · {o.reason}
                            </span>
                          </span>
                          <StatusPill tone={REQUEST_TONE[o.status]}>{REQUEST_STATUS_LABEL[o.status]}</StatusPill>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>

              <Card aria-labelledby="loan-title">
                <CardHeader id="loan-title" title="Loans and advances" />
                {loans.length === 0 ? (
                  <p className="text-sm text-muted">No loans.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {loans.map((l) => (
                      <li key={l.id} className="flex items-center gap-3 py-2 text-sm">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">
                            {LOAN_KIND_LABEL[l.kind]} {money(l.amount)} · {plural(l.installments, 'instalment')} of {money(l.monthly)}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {l.reason} · {money(l.outstanding)} outstanding
                          </span>
                        </span>
                        <StatusPill tone={LOAN_TONE[l.status]}>{LOAN_STATUS_LABEL[l.status]}</StatusPill>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>

            <div className="space-y-4">
              <Card aria-labelledby="slips-title">
                <CardHeader id="slips-title" title="Payslips" />
                {payslips.length === 0 ? (
                  <p className="text-sm text-muted">No payroll yet.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {payslips.map(({ period, line }) => (
                      <li key={period.id}>
                        <Link to={`/payroll/${period.id}/${e.id}`} className="flex items-center gap-3 py-2.5 text-sm hover:underline">
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">{period.month}</span>
                            <span className="block text-xs text-muted">{line ? money(line.net) : 'Not on this run'}</span>
                          </span>
                          <Tag tone={PAYROLL_TONE[period.status]}>{PAYROLL_STATUS_LABEL[period.status]}</Tag>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card aria-labelledby="kpi-title">
                <CardHeader id="kpi-title" title="KPI" action={can('hr', 'edit') && <Link to={`/hr/kpi?employee=${e.id}`} className="text-sm text-accent-text hover:underline">Review</Link>} />
                {kpis.length === 0 ? (
                  <p className="text-sm text-muted">No review yet.</p>
                ) : (
                  <>
                    {kpis[0] && (
                      <div className="mb-3 flex items-center gap-3">
                        <ScoreMeter score={Math.min(100, kpis[0].score)} label={`KPI score ${kpis[0].period}`} />
                        <span className="shrink-0 text-lg font-semibold tabular">{kpis[0].score}</span>
                      </div>
                    )}
                  <ul className="divide-y divide-line">
                    {kpis.map((k) => (
                      <li key={k.id} className="flex items-center gap-3 py-2.5 text-sm">
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{k.period}</span>
                          <span className="block text-xs text-muted">
                            {k.status === 'published' ? KPI_BAND_LABEL[kpiBand(k.score)] : 'Draft'} · {k.reviewer}
                          </span>
                        </span>
                        <Tag tone={k.status === 'published' ? KPI_TONE[kpiBand(k.score)] : 'neutral'}>{k.score}</Tag>
                      </li>
                    ))}
                  </ul>
                  </>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </Gate>
  )
}
