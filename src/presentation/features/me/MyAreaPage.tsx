import { Link } from 'react-router'
import { ArrowRight, Megaphone, Pin, Plus } from 'lucide-react'
import { LEAVE_KIND_LABEL, LOAN_STATUS_LABEL, REQUEST_STATUS_LABEL } from '@/domain/hr'
import { kpiBand, KPI_BAND_LABEL } from '@/domain/people'
import { cn } from '@/lib/cn'
import { shortDay, weekdayDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { ScoreMeter } from '../../charts/ScoreMeter'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { POP } from '../../ui/pop'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { KPI_TONE, LOAN_TONE, REQUEST_TONE } from '../shared/tones'
import { BreakdownDonut } from '../hr/BreakdownDonut'
import { attendanceSlices } from '../hr/chartSeries'
import { WindowTag } from '../shared/WindowTag'
import { SETUP_LABEL } from '@/domain/hospitality'

/** The employee home: this month, the next shifts, the latest payslip, the KPI and the notices. */
export default function MyAreaPage() {
  const { people } = useServices()
  const data = useResource('people.home', () => people.home())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  if (!d.employee) {
    return (
      <EmptyState
        title="This login is not linked to an employee record"
        action={
          <Link to="/login" className={buttonStyles({ variant: 'solid', size: 'sm' })}>
            Switch login
          </Link>
        }
      >
        {d.user.name} signs in as {d.user.role}. Sign in as an employee, for example Wayan Sudiarta, to see shifts, leave and payslips.
      </EmptyState>
    )
  }
  const e = d.employee
  const pending = [...d.leaves.filter((l) => l.status === 'pending'), ...d.overtime.filter((o) => o.status === 'pending')].length + d.loans.filter((l) => l.status === 'pending').length
  const pinned = d.announcements.filter((a) => a.pinned)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">
          Hi, {e.name.split(' ')[0]}. {e.position} at {e.villaNames}; {plural(e.leaveLeft, 'annual leave day')} left this year.
        </p>
        <Link to="/me/requests" className={buttonStyles({ variant: 'accent' })}>
          <Plus aria-hidden className="size-4" /> New request
        </Link>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Present this month" value={d.attendance.present + d.attendance.late} hint={`${d.attendance.late} late`} to="/hr/attendance" />
        <StatTile label="Absent" value={d.attendance.absent} hint={`${d.attendance.leave} on leave`} to="/hr/attendance?status=absent" />
        <StatTile label="Leave left" value={plural(d.leaveLeft, 'day')} to="/me/requests" />
        <StatTile label="Overtime this month" value={`${d.overtimeHoursMonth} h`} hint="Approved" to="/me/requests" />
        <StatTile label="Pending requests" value={pending} to="/me/requests" />
        <StatTile label="KPI" value={d.kpi ? d.kpi.score : '–'} hint={d.kpi ? KPI_BAND_LABEL[kpiBand(d.kpi.score)] : 'No review yet'} to="/me/kpi" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          <Card aria-labelledby="my-shifts">
            <CardHeader id="my-shifts" title="Next seven days" />
            <ul className="grid grid-cols-7 gap-1.5">
              {d.shifts.map((s) => (
                <li key={s.date} className={cn('rounded-panel p-2 text-center text-xs', s.date === d.today && 'ring-2 ring-accent', s.shift ? 'bg-invert text-on-invert' : 'bg-raised text-muted')}>
                  <span className="block">{weekdayDay(s.date)}</span>
                  <span className="mt-1 block truncate font-medium">{s.shift ? s.shift.name : s.assignment ? 'Off' : '·'}</span>
                  <span className="block truncate opacity-70">{s.shift ? s.shift.start : ''}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">{d.shifts[0]?.villa ? `At ${d.shifts[0].villa.name}.` : 'Ask your manager when the roster is not set.'}</p>
          </Card>
          {d.hosting.length > 0 && (
            <Card aria-labelledby="my-stays">
              <CardHeader id="my-stays" title="Stays I host" />
              <ul className="divide-y divide-line">
                {d.hosting.map((h) => (
                  <li key={h.id} className="space-y-1.5 py-3 first:pt-0 last:pb-0 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/bookings/${h.id}`} className="font-mono text-xs font-semibold hover:underline">
                        {h.code}
                      </Link>
                      <span className="min-w-0 flex-1 truncate font-medium">{h.guestName}</span>
                      <StatusPill tone={h.status === 'checked_in' ? 'success' : 'info'}>{h.status === 'checked_in' ? 'In house' : `Arrives ${shortDay(h.checkIn)}`}</StatusPill>
                    </div>
                    <p className="text-xs text-muted">
                      {h.unitCode}, {h.villaName} · {shortDay(h.checkIn)} to {shortDay(h.checkOut)}
                      {h.preferences.arrivalTime && ` · arrives ${h.preferences.arrivalTime}`}
                      {h.preferences.breakfastTime && ` · breakfast ${h.preferences.breakfastTime}`}
                      {h.preferences.dietary && ` · ${h.preferences.dietary}`}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <WindowTag window={h.window} />
                      {h.preferences.setups.map((x) => (
                        <Tag key={x} tone="info">
                          {SETUP_LABEL[x]}
                        </Tag>
                      ))}
                    </div>
                    {h.preferences.notes && <p className="text-xs text-body">{h.preferences.notes}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {pinned.length > 0 && (
            <ul className="space-y-3">
              {pinned.map((a) => (
                <li key={a.id} className={cn('rounded-card p-5', POP.blue)}>
                  <p className="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase opacity-70">
                    <Pin aria-hidden className="size-3.5" /> Pinned
                  </p>
                  <h2 className="mt-2 text-lg font-semibold tracking-tight">{a.title}</h2>
                  <p className="mt-1 text-sm opacity-90">{a.body}</p>
                </li>
              ))}
            </ul>
          )}
          <Card aria-labelledby="my-requests">
            <CardHeader
              id="my-requests"
              title="My requests"
              action={
                <Link to="/me/requests" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                  All <ArrowRight aria-hidden className="size-4" />
                </Link>
              }
            />
            {d.leaves.length + d.overtime.length + d.loans.length === 0 ? (
              <p className="text-sm text-muted">No requests yet.</p>
            ) : (
              <ul className="divide-y divide-line text-sm">
                {d.leaves.slice(0, 3).map((l) => (
                  <li key={l.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate">
                      {LEAVE_KIND_LABEL[l.kind]} · {shortDay(l.from)} · {plural(l.days, 'day')}
                    </span>
                    <StatusPill tone={REQUEST_TONE[l.status]}>{REQUEST_STATUS_LABEL[l.status]}</StatusPill>
                  </li>
                ))}
                {d.overtime.slice(0, 3).map((o) => (
                  <li key={o.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate">
                      Overtime {o.hours} h · {shortDay(o.date)}
                    </span>
                    <StatusPill tone={REQUEST_TONE[o.status]}>{REQUEST_STATUS_LABEL[o.status]}</StatusPill>
                  </li>
                ))}
                {d.loans.slice(0, 2).map((l) => (
                  <li key={l.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate">
                      Loan {money(l.amount)} · {money(l.outstanding)} left
                    </span>
                    <StatusPill tone={LOAN_TONE[l.status]}>{LOAN_STATUS_LABEL[l.status]}</StatusPill>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card aria-labelledby="my-notices">
            <CardHeader
              id="my-notices"
              title="Announcements"
              action={
                <Link to="/me/announcements" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                  All <ArrowRight aria-hidden className="size-4" />
                </Link>
              }
            />
            <ul className="divide-y divide-line">
              {d.announcements
                .filter((a) => !a.pinned)
                .slice(0, 4)
                .map((a) => (
                  <li key={a.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <Megaphone aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                    <span className="min-w-0">
                      <span className="block font-medium">{a.title}</span>
                      <span className="line-clamp-2 text-sm text-muted">{a.body}</span>
                      <span className="block text-xs text-muted">
                        {a.by} · {shortDay(a.publishedOn)}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
          </Card>
        </div>
        <div className="space-y-4">
          <Link to={d.payslip ? `/me/payslips/${d.payslip.period.id}` : '/me/payslips'} className={cn('block rounded-card p-5 transition-opacity hover:opacity-90', POP.ink)}>
            <p className="text-xs font-semibold tracking-wider uppercase opacity-70">Latest payslip</p>
            {d.payslip?.line ? (
              <>
                <p className="mt-3 min-w-0 text-[28px] leading-none font-medium tracking-tight break-words tabular">{money(d.payslip.line.net)}</p>
                <p className="mt-2 text-sm opacity-80">
                  {d.payslip.label} · gross {money(d.payslip.line.gross)}
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm opacity-80">No payslip published yet.</p>
            )}
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium">
              Open <ArrowRight aria-hidden className="size-4" />
            </span>
          </Link>
          <Card aria-labelledby="my-kpi">
            <CardHeader id="my-kpi" title="KPI" action={<Link to="/me/kpi" className="text-sm text-accent-text hover:underline">Details</Link>} />
            {d.kpi ? (
              <>
                <div className="flex items-end gap-3">
                  <p className="text-[40px] leading-none font-medium tracking-tight tabular">{d.kpi.score}</p>
                  <Tag tone={KPI_TONE[kpiBand(d.kpi.score)]} className="mb-1">
                    {KPI_BAND_LABEL[kpiBand(d.kpi.score)]}
                  </Tag>
                </div>
                <p className="mt-2 text-sm text-muted">
                  {d.kpi.period} · reviewed by {d.kpi.reviewer}
                </p>
                <ScoreMeter score={Math.min(100, d.kpi.score)} label={`KPI score ${d.kpi.period}`} className="mt-3" />
                {d.kpi.note && <p className="mt-2 text-sm text-body">{d.kpi.note}</p>}
              </>
            ) : (
              <p className="text-sm text-muted">No published review yet.</p>
            )}
          </Card>
          <Card aria-labelledby="my-attendance">
            <CardHeader id="my-attendance" title="This month" />
            <BreakdownDonut label="Attendance this month" stacked size={140} slices={attendanceSlices(d.attendance)} format={(v) => plural(v, 'day')} empty="No days recorded yet this month." className="mb-4" />
            <ul className="divide-y divide-line text-sm">
              {d.attendance.rows.slice(0, 6).map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-2">
                  <span className="w-16 shrink-0 text-xs text-muted">{shortDay(a.date)}</span>
                  <span className="min-w-0 flex-1 truncate">{a.clockIn ? `${a.clockIn} to ${a.clockOut ?? '…'}` : a.status}</span>
                  {a.lateMinutes > 0 && <span className="text-xs text-warning">{a.lateMinutes} min late</span>}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  )
}
