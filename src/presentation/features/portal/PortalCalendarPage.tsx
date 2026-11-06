import { useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { spanNights } from '@/domain/owner'
import { cn } from '@/lib/cn'
import { addDays, daysBetween, eachDay, maxIso, parseIsoDay, shortDay } from '@/lib/dates'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CardSkeleton, ErrorState } from '../../ui/States'

const DAYS = 21
const KIND_STYLE = { stay: 'bg-info-soft text-info', owner: 'bg-accent-strong text-white', block: 'bg-control text-muted' } as const

/** Three weeks of the owner's units: guest stays by source, owner stays and closed nights. No guest names. */
export default function PortalCalendarPage() {
  const { portal, clock } = useServices()
  const [from, setFrom] = useState(clock.today())
  const data = useResource(`portal.calendar:${from}`, () => portal.calendar(from, DAYS))

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const days = eachDay(d.from, d.to)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="card" size="icon" aria-label="Earlier" onClick={() => setFrom(addDays(from, -DAYS))}>
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button variant="card" size="icon" aria-label="Later" onClick={() => setFrom(addDays(from, DAYS))}>
          <ChevronRight aria-hidden className="size-4" />
        </Button>
        <p className="text-sm text-muted">
          {shortDay(d.from)} to {shortDay(addDays(d.to, -1))}
        </p>
        <ul className="ml-auto flex flex-wrap gap-3 text-xs text-muted">
          <li className="flex items-center gap-1.5"><span className={cn('size-3 rounded-full', KIND_STYLE.stay)} /> Guest stay</li>
          <li className="flex items-center gap-1.5"><span className={cn('size-3 rounded-full', KIND_STYLE.owner)} /> Owner stay</li>
          <li className="flex items-center gap-1.5"><span className={cn('size-3 rounded-full', KIND_STYLE.block)} /> Closed</li>
        </ul>
      </div>
      <Card className="overflow-x-auto p-0">
        <div className="min-w-[720px]" style={{ display: 'grid', gridTemplateColumns: `6rem repeat(${DAYS}, minmax(0, 1fr))` }}>
          <div className="border-b border-line p-2 text-xs font-medium text-muted">Unit</div>
          {days.map((day) => (
            <div key={day} className={cn('border-b border-line py-2 text-center text-xs tabular', day === d.today ? 'font-semibold text-accent' : 'text-muted')}>
              {parseIsoDay(day)}
            </div>
          ))}
          {d.units.map((u) => (
            <div key={u.id} className="contents">
              <div className="border-b border-line p-2 text-sm font-medium">{u.code}</div>
              <div className="relative border-b border-line" style={{ gridColumn: `span ${DAYS}`, minHeight: '2.75rem' }}>
                {d.spans
                  .filter((s) => s.unitId === u.id)
                  .map((s) => {
                    const start = daysBetween(d.from, maxIso(s.from, d.from))
                    const width = spanNights(s, d.from, d.to)
                    return (
                      <span
                        key={s.id}
                        title={`${s.label}, ${shortDay(s.from)} to ${shortDay(s.to)}`}
                        className={cn('absolute top-1.5 bottom-1.5 truncate rounded-full px-2 text-xs leading-7', KIND_STYLE[s.kind])}
                        style={{ left: `calc(${(start / DAYS) * 100}% + 2px)`, width: `calc(${(width / DAYS) * 100}% - 4px)` }}
                      >
                        {s.label}
                      </span>
                    )
                  })}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <p className="text-xs text-muted">Guests stay anonymous here: you see the dates and where the booking came from.</p>
    </div>
  )
}
