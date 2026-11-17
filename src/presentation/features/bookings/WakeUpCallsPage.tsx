import { useSearchParams } from 'react-router'
import { Search } from 'lucide-react'
import { addDays } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Card } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { WakeUpList } from './WakeUpList'

type Day = 'today' | 'tomorrow'

/**
 * Today's pending wake-up calls of stays in house, by time, with tomorrow's one tap away. A call whose
 * time has passed, or that a past morning missed, reads overdue. Calls are booked on the booking page.
 */
export default function WakeUpCallsPage() {
  const { frontDesk, clock } = useServices()
  const [params, setParams] = useSearchParams()
  const day = (params.get('day') ?? 'today') as Day
  const query = (params.get('q') ?? '').trim().toLowerCase()
  const today = useResource('frontDesk.wakeUpCalls:today', () => frontDesk.wakeUpCalls())
  const tomorrow = useResource('frontDesk.wakeUpCalls:tomorrow', () => frontDesk.wakeUpCalls(addDays(clock.today(), 1)))
  const data = day === 'today' ? today : tomorrow

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!today.data || !data.data) return <CardSkeleton lines={6} />
  const set = (k: string, v: string) => {
    const search = new URLSearchParams(params)
    if (v && v !== 'today') search.set(k, v)
    else search.delete(k)
    setParams(search, { replace: true })
  }
  const rows = data.data.rows.filter((r) => !query || [r.unitCode, r.guestName, r.code, r.villaName].some((x) => x.toLowerCase().includes(query)))
  const reload = () => {
    today.reload()
    tomorrow.reload()
  }

  return (
    <Card className="p-0" aria-label="Wake-up calls">
      <TableToolbar
        chips={[
          { value: 'today' as Day, label: 'Today', count: today.data.rows.length },
          { value: 'tomorrow' as Day, label: 'Tomorrow', count: tomorrow.data?.rows.length ?? 0 },
        ]}
        chip={day}
        onChip={(d) => set('day', d)}
        chipLabel="Day"
        search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Room, guest or booking" aria-label="Search wake-up calls" value={params.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} />}
        active={Boolean(query)}
        onClear={() => set('q', '')}
        summary={`${rows.length} of ${data.data.rows.length} calls`}
      />
      <div className="p-5 pt-2">
        <WakeUpList rows={rows} today={today.data.today} actions={day === 'today'} onChanged={reload} empty={query ? 'No call matches the search.' : day === 'today' ? 'No wake-up call is waiting. Book one on the guest’s booking.' : 'No wake-up call is booked for tomorrow yet.'} />
      </div>
    </Card>
  )
}
