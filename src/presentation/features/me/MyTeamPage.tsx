import { weekdayDay } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card } from '../../ui/Card'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'

/** The next seven days of everyone who shares a villa with the employee: who is on which shift. */
export default function MyTeamPage() {
  const { people } = useServices()
  const data = useResource('people.home:team', () => people.home())
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const days = d.team[0]?.days ?? []
  return (
    <>
      <PageBar fallback="/me" label="Home" />
      {d.team.length === 0 ? (
        <EmptyState title="No team roster to show">Sign in as an employee with a villa to see who works the coming week.</EmptyState>
      ) : (
        <Card className="p-0" aria-label="Team shifts, next seven days">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th scope="col" className="px-5 py-3 font-medium">Team member</th>
                  {days.map((day) => (
                    <th key={day.date} scope="col" className={cn('px-2 py-3 text-center font-medium', day.date === d.today && 'text-accent-text')}>
                      {weekdayDay(day.date)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.team.map((member) => (
                  <tr key={member.id}>
                    <th scope="row" className="px-5 py-3 text-left font-normal">
                      <span className="block font-medium">{member.name}{member.id === d.employee?.id && ' (you)'}</span>
                      <span className="block text-xs text-muted">{member.position}</span>
                    </th>
                    {member.days.map((day) => (
                      <td key={day.date} className="px-1 py-2 text-center">
                        <span className={cn('block rounded-panel px-1 py-1.5 text-xs', day.shift ? 'bg-invert text-on-invert' : 'bg-raised text-muted')}>
                          <span className="block truncate font-medium">{day.shift ? day.shift.name : day.assigned ? 'Off' : '·'}</span>
                          <span className="block truncate opacity-70">{day.shift?.start ?? ' '}</span>
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}
