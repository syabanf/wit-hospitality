import { ATTENDANCE_STATUS_LABEL } from '@/domain/hr'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card, CardHeader } from '../../ui/Card'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { BreakdownDonut } from '../hr/BreakdownDonut'
import { attendanceSlices } from '../hr/chartSeries'
import { placeLabel } from '@/domain/selfService'
import { ClockCard } from './ClockCard'

/** The employee's own attendance: the clock for today, the month's split by status and every recorded day. */
export default function MyAttendancePage() {
  const { people } = useServices()
  const data = useResource('people.home:attendance', () => people.home())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  return (
    <>
      <PageBar fallback="/me" label="Home" />
      {!d.employee ? (
        <EmptyState title="This login is not linked to an employee record">Sign in as an employee to see attendance.</EmptyState>
      ) : (
        <div className="space-y-4">
          {d.clock && <ClockCard clock={d.clock} today={d.today} onDone={data.reload} />}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
            <Card aria-labelledby="att-month">
              <CardHeader id="att-month" title="This month" />
              <BreakdownDonut label="Attendance this month" stacked size={160} slices={attendanceSlices(d.attendance)} format={(v) => plural(v, 'day')} empty="No days recorded yet this month." />
            </Card>
            <Card aria-labelledby="att-days">
              <CardHeader id="att-days" title="Days recorded" />
              {d.attendance.monthRows.length === 0 ? (
                <p className="text-sm text-muted">No days recorded yet this month.</p>
              ) : (
                <ul className="divide-y divide-line text-sm">
                  {d.attendance.monthRows.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 py-2.5">
                      <span className="w-16 shrink-0 text-xs text-muted">{shortDay(a.date)}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{a.clockIn ? `${a.clockIn} to ${a.clockOut ?? '…'}` : ATTENDANCE_STATUS_LABEL[a.status]}</span>
                        {a.source === 'self' && (
                          <span className="block truncate text-xs text-muted">
                            {placeLabel(a.clockInGeo)}
                            {a.corrected && ' · corrected by HR'}
                            {a.note && ` · ${a.note}`}
                          </span>
                        )}
                      </span>
                      {a.lateMinutes > 0 && <span className="text-xs text-warning">{a.lateMinutes} min late</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  )
}
