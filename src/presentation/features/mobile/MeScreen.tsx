import { Link } from 'react-router'
import { ArrowRight, Pin } from 'lucide-react'
import { REQUEST_STATUS_LABEL } from '@/domain/hr'
import { cn } from '@/lib/cn'
import { weekdayDay } from '@/lib/dates'
import { money, plural } from '@/lib/format'
import { ScoreMeter } from '../../charts/ScoreMeter'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { POP } from '../../ui/pop'
import { Skeleton } from '../../ui/States'
import { REQUEST_TONE } from '../shared/tones'
import { BreakdownDonut } from '../hr/BreakdownDonut'
import { attendanceSlices } from '../hr/chartSeries'
import { Screen } from './Screen'

/** The employee home on a phone: this month, the next shifts, the latest payslip and the pinned notice. */
export function MeScreen() {
  const { people } = useServices()
  const data = useResource('people.home:m', () => people.home())
  const d = data.data
  const pendingRequests = d
    ? [...d.leaves.map((l) => ({ id: l.id, text: `${plural(l.days, 'day')} leave`, status: l.status })), ...d.overtime.map((o) => ({ id: o.id, text: `${o.hours} h overtime`, status: o.status }))].filter((r) => r.status === 'pending').slice(0, 4)
    : []
  return (
    <Screen title="My area" back={false}>
      {!d ? (
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-[22px]" />
          <Skeleton className="h-40 rounded-[22px]" />
        </div>
      ) : !d.employee ? (
        <div className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">
          {d.user.name} is not linked to an employee record.{' '}
          <Link to="/login" className="text-accent-text underline">
            Switch login
          </Link>
        </div>
      ) : (
        <>
          <div className="stagger grid grid-cols-3 gap-2">
            <div className={cn('rounded-[22px] p-3', POP.blue)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Present</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.attendance.present + d.attendance.late}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.red)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Late</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.attendance.late}</p>
            </div>
            <div className={cn('rounded-[22px] p-3', POP.ink)}>
              <p className="text-[11px] font-medium uppercase opacity-80">Leave</p>
              <p className="mt-2 text-[28px] leading-none font-semibold tabular">{d.leaveLeft}</p>
            </div>
          </div>
          <div className="rounded-[22px] bg-card p-4 shadow-card">
            <p className="mb-3 text-xs text-muted">Attendance this month</p>
            <BreakdownDonut label="Attendance this month" size={120} slices={attendanceSlices(d.attendance)} format={(v) => plural(v, 'day')} empty="No days recorded yet this month." />
          </div>
          <section aria-labelledby="m-shifts">
            <h2 id="m-shifts" className="mb-2 text-base font-semibold">
              Next shifts
            </h2>
            <ul className="grid grid-cols-7 gap-1">
              {d.shifts.map((s) => (
                <li key={s.date} className={cn('rounded-xl p-1.5 text-center text-[11px]', s.date === d.today && 'ring-2 ring-accent', s.shift ? 'bg-invert text-on-invert' : 'bg-card text-muted shadow-card')}>
                  <span className="block">{weekdayDay(s.date).slice(0, 3)}</span>
                  <span className="mt-0.5 block truncate font-semibold">{s.shift ? s.shift.start : s.assignment ? 'Off' : '·'}</span>
                </li>
              ))}
            </ul>
          </section>
          <Link to={d.payslip ? `/me/payslips/${d.payslip.period.id}` : '/me/payslips'} className="block rounded-[22px] bg-card p-4 shadow-card active:scale-[0.99]">
            <p className="text-xs text-muted">Latest payslip{d.payslip ? `, ${d.payslip.label}` : ''}</p>
            <p className="mt-1 min-w-0 text-2xl font-semibold tracking-tight break-words tabular">{d.payslip?.line ? money(d.payslip.line.net) : 'Not published yet'}</p>
          </Link>
          {d.kpi && (
            <Link to="/me/kpi" className="block rounded-[22px] bg-card p-4 shadow-card active:scale-[0.99]">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs text-muted">KPI {d.kpi.period}</p>
                <span className="text-lg font-semibold tabular">{d.kpi.score}</span>
              </div>
              <ScoreMeter score={Math.min(100, d.kpi.score)} label={`KPI score ${d.kpi.period}`} className="mt-2" />
            </Link>
          )}
          {d.announcements.filter((a) => a.pinned).slice(0, 1).map((a) => (
            <div key={a.id} className={cn('rounded-[22px] p-4', POP.blush)}>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider uppercase opacity-70">
                <Pin aria-hidden className="size-3" /> Pinned
              </p>
              <p className="mt-1 font-semibold">{a.title}</p>
              <p className="mt-1 text-sm opacity-90">{a.body}</p>
            </div>
          ))}
          <section aria-labelledby="m-requests">
            <div className="mb-2 flex items-center justify-between">
              <h2 id="m-requests" className="text-base font-semibold">
                Requests
              </h2>
              <Link to="/me/requests" className={buttonStyles({ variant: 'solid', size: 'sm' })}>
                New <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </div>
            {pendingRequests.length === 0 && <p className="rounded-[22px] bg-card p-4 text-sm text-muted shadow-card">Nothing waits for a decision.</p>}
            <ul className="space-y-2">
              {pendingRequests.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 rounded-[22px] bg-card p-3 text-sm shadow-card">
                    <span className="min-w-0 flex-1 truncate">{r.text}</span>
                    <StatusPill tone={REQUEST_TONE[r.status]}>{REQUEST_STATUS_LABEL[r.status]}</StatusPill>
                  </li>
                ))}
            </ul>
          </section>
        </>
      )}
    </Screen>
  )
}
