import { useState } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { addDays, weekdayDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Select } from '../../ui/Field'
import { Skeleton } from '../../ui/States'
import { NIGHT_LABEL } from '../shared/tones'
import { Screen } from './Screen'

const DAYS = 7
const CELL = {
  free: 'bg-white/60 text-ink',
  occupied: 'bg-ink text-white',
  blocked: 'hatch bg-white/25 text-ink/70',
  closed: 'bg-white/10 text-ink/40 line-through',
} as const

export function AvailabilityScreen() {
  const { booking, dashboard, clock } = useServices()
  const options = useResource('dashboard.filterOptions', () => dashboard.filterOptions())
  const [locationId, setLocationId] = useState('')
  const today = clock.today()
  const cal = useResource(`booking.calendar:m|${locationId}`, () => booking.calendar(today, DAYS, { locationId: locationId || undefined }))

  return (
    <Screen
      title="Free nights"
      band="blue"
      actions={
        options.data && (
          <Select
            compact
            tone="card"
            aria-label="Location"
            value={locationId}
            options={[{ value: '', label: 'All' }, ...options.data.catalog.locations.map((l) => ({ value: l.id, label: l.name }))]}
            onChange={(e) => setLocationId(e.target.value)}
          />
        )
      }
    >
      {!cal.data ? (
        <Skeleton className="h-96 rounded-[26px]" />
      ) : (
        <>
          <div className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-1 px-1 text-center text-[10px] font-medium text-muted">
            <span />
            {cal.data.days.map((d) => (
              <span key={d} className={cn(d === today && 'text-accent-text')}>
                {weekdayDay(d).replace(' ', '\n')}
              </span>
            ))}
          </div>
          {[...new Map(cal.data.rows.map((r) => [r.place.villa.id, r.place.villa])).values()].map((villa) => (
            <section key={villa.id} aria-label={villa.name} className={cn('rounded-[26px] p-3', 'bg-pop-blue text-ink')}>
              <p className="mb-2 px-1 text-sm font-semibold">{villa.name}</p>
              <ul className="space-y-1">
                {cal.data?.rows
                  .filter((r) => r.place.villa.id === villa.id)
                  .map((row) => (
                    <li key={row.place.unit.id} className="grid grid-cols-[3.5rem_repeat(7,minmax(0,1fr))] gap-1">
                      <Link to={`/property/units/${row.place.unit.id}`} className="flex items-center px-1 font-mono text-xs font-semibold">
                        {row.place.unit.code}
                      </Link>
                      {row.states.map((state, i) => {
                        const day = cal.data?.days[i] ?? today
                        const span = row.spans.find((s) => s.kind === 'booking' && s.start <= i && i < s.start + s.length)
                        const to = span ? `/m/bookings/${span.id}` : state === 'free' ? `/bookings/new?unit=${row.place.unit.id}&checkIn=${day}&checkOut=${addDays(day, 1)}` : `/property/units/${row.place.unit.id}`
                        return (
                          <Link key={day} to={to} aria-label={`${row.place.unit.code} ${weekdayDay(day)}: ${NIGHT_LABEL[state]}`} className={cn('grid h-9 place-items-center rounded-lg text-[10px] font-semibold', CELL[state])}>
                            {state === 'occupied' ? (span?.label.split(' ')[0] ?? '') : state === 'free' ? '' : '·'}
                          </Link>
                        )
                      })}
                    </li>
                  ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </Screen>
  )
}
