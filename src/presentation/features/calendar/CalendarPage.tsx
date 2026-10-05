import { useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import type { CalendarSpan } from '@/application/views'
import { BLOCK_REASON_LABEL, type BlockReason } from '@/domain/booking'
import type { Scope } from '@/domain/property'
import { cn } from '@/lib/cn'
import { addDays, daysBetween, shortDay, weekdayDay } from '@/lib/dates'
import { seriesColor } from '../../charts/colors'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { ViewToggle } from '../../ui/ViewToggle'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { StatTile } from '../../ui/StatTile'
import { BookingTable } from '../shared/BookingTable'
import { ScopePicker } from '../shared/ScopePicker'
import { NIGHT_CLASS } from '../shared/tones'

const DEFAULT_DAYS = 14
const MIN_DAYS = 7
const MAX_DAYS = 92
const DAY_PX = 60
const UNIT_PX = 112

/** Units in one night state on the night the tiles describe: today when visible, else the first day shown. */
function count(d: { days: string[]; today: string; rows: ReadonlyArray<{ states: readonly string[] }> }, state: string) {
  const i = Math.max(0, d.days.indexOf(d.today))
  return d.rows.filter((r) => r.states[i] === state).length
}

function spanStyle(span: CalendarSpan) {
  if (span.kind === 'block') return {}
  const color = seriesColor(span.slot)
  return { background: `color-mix(in oklab, ${color} 18%, var(--color-card))`, borderColor: color }
}

/**
 * Units by villa against a date range: stays as bars, blocks hatched, free nights clickable.
 * The range comes from the date filter (default yesterday plus two weeks); the day axis scrolls
 * inside the card with the unit column pinned, and opens on today.
 */
export default function CalendarPage() {
  const { booking, dashboard, clock } = useServices()
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useLayout()
  const today = clock.today()
  const defaultFrom = addDays(today, -1)
  const from = params.get('from') ?? defaultFrom
  const requested = params.get('to') ?? addDays(from, DEFAULT_DAYS - 1)
  const days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, daysBetween(from, requested) + 1))
  const to = addDays(from, days - 1)
  const scope: Scope = { locationId: params.get('location') ?? undefined, villaId: params.get('villa') ?? undefined }
  const options = useResource('dashboard.filterOptions', () => dashboard.filterOptions())
  const data = useResource(`booking.calendar:${from}|${days}|${scope.locationId}|${scope.villaId}`, () => booking.calendar(from, days, scope))
  const scroller = useRef<HTMLDivElement>(null)

  // Block body on purpose: scrollTo may return a Promise, and an effect may only return a cleanup.
  useEffect(() => {
    const i = data.data?.days.indexOf(today) ?? -1
    if (i >= 0) scroller.current?.scrollTo({ left: Math.max(0, i * DAY_PX - DAY_PX), behavior: 'smooth' })
  }, [data.data, today])

  function update(next: { from?: string; to?: string; locationId?: string; villaId?: string }) {
    const merged = { from, to, ...scope, ...next }
    const search = new URLSearchParams()
    if (layout === 'table') search.set('layout', 'table')
    if (merged.from !== defaultFrom || merged.to !== addDays(merged.from, DEFAULT_DAYS - 1)) {
      search.set('from', merged.from)
      search.set('to', merged.to)
    }
    if (merged.locationId) search.set('location', merged.locationId)
    if (merged.villaId) search.set('villa', merged.villaId)
    setParams(search, { replace: true })
  }
  const shift = (by: number) => update({ from: addDays(from, by), to: addDays(to, by) })

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  const d = data.data
  const villas = d ? [...new Map(d.rows.map((r) => [r.place.villa.id, r.place.villa])).values()] : []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="card" size="icon" aria-label="Previous week" onClick={() => shift(-7)}>
          <ChevronLeft aria-hidden className="size-4" />
        </Button>
        <Button variant="card" size="icon" aria-label="Next week" onClick={() => shift(7)}>
          <ChevronRight aria-hidden className="size-4" />
        </Button>
        <Button variant="card" onClick={() => update({ from: defaultFrom, to: addDays(defaultFrom, DEFAULT_DAYS - 1) })}>
          Today
        </Button>
        <DateRangeFilter
          today={today}
          tone="card"
          label="Nights"
          value={{ from, to }}
          onChange={(r) => {
            const nextFrom = r.from ?? defaultFrom
            const nextTo = r.to && r.to >= nextFrom ? r.to : addDays(nextFrom, DEFAULT_DAYS - 1)
            update({ from: nextFrom, to: nextTo })
          }}
        />
        <p className="text-xs text-muted tabular">{days} nights</p>
        {options.data && (
          <ScopePicker catalog={options.data.catalog} value={scope} tone="card" units={false} onChange={(s) => update({ locationId: s.locationId, villaId: s.villaId })} className="flex min-w-0 basis-full gap-2 sm:ml-auto sm:basis-auto" />
        )}
        <ViewToggle value={layout} onChange={setLayout} />
        <Link to="/bookings/new" className={buttonStyles({ variant: 'accent' })}>
          <Plus aria-hidden className="size-4" /> New booking
        </Link>
      </div>
      <ul className="flex flex-wrap gap-3 text-xs text-muted">
        {d?.sources.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-full" style={{ background: seriesColor(s.slot) }} /> {s.label}
          </li>
        ))}
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="hatch inline-block size-2.5 rounded-sm border border-line-strong bg-control" /> Blocked
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-4 rounded-sm bg-invert" /> Checked in
        </li>
      </ul>

      {d && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          <StatTile label={`Occupied ${d.days.includes(d.today) ? 'tonight' : shortDay(d.days[0] ?? d.from)}`} value={count(d, 'occupied')} hint={`of ${d.rows.length} units`} to="/bookings?status=checked_in" />
          <StatTile label={`Free ${d.days.includes(d.today) ? 'tonight' : shortDay(d.days[0] ?? d.from)}`} value={count(d, 'free')} hint="Sellable units" to="/bookings/new" />
          <StatTile label="Arrivals in window" value={d.stays.filter((b) => b.checkIn >= d.from && b.checkIn < d.to).length} hint={`${shortDay(d.from)} to ${shortDay(addDays(d.to, -1))}`} to="/bookings?status=confirmed" />
          <StatTile label="Departures in window" value={d.stays.filter((b) => b.checkOut >= d.from && b.checkOut < d.to).length} hint="Check-out mornings" to="/bookings?status=checked_in" />
          <StatTile label="Blocked nights" value={d.blocks.reduce((n, k) => n + Math.max(0, Math.min(daysBetween(d.from, k.to), days) - Math.max(0, daysBetween(d.from, k.from))), 0)} hint={`${d.blocks.length} blocks`} to="/?view=operational" className="col-span-2 sm:col-span-1" />
        </div>
      )}
      {!d ? (
        <CardSkeleton lines={10} />
      ) : layout === 'table' ? (
        <>
          <Card className="p-0" aria-labelledby="cal-stays">
            <div className="p-5 pb-0">
              <CardHeader id="cal-stays" title="Stays in this window" />
            </div>
            <BookingTable label="Stays in this window" rows={d.stays} exportName="calendar" exportDate={d.from} />
          </Card>
          <Card aria-labelledby="cal-blocks">
            <CardHeader id="cal-blocks" title="Blocks in this window" />
            {d.blocks.length === 0 ? (
              <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No blocks in these two weeks.</p>
            ) : (
              <DataTable
                label="Blocks"
                rows={d.blocks}
                rowKey={(k) => k.id}
                columns={[
                  { key: 'u', header: 'Unit', cell: (k) => <Link to={`/property/units/${k.unitId}`} className="font-mono hover:underline">{k.place.unit.code}</Link> },
                  { key: 'v', header: 'Villa', cell: (k) => k.place.villa.name },
                  { key: 'r', header: 'Reason', cell: (k) => BLOCK_REASON_LABEL[k.reason] },
                  { key: 'f', header: 'From', cell: (k) => shortDay(k.from) },
                  { key: 't', header: 'To', cell: (k) => shortDay(k.to) },
                  { key: 'n', header: 'Note', cell: (k) => k.note },
                ]}
              />
            )}
          </Card>
        </>
      ) : (
        <Card className="overflow-hidden p-0" aria-label="Booking calendar">
          <div ref={scroller} className="overflow-x-auto">
            <div style={{ minWidth: UNIT_PX + days * DAY_PX }}>
              <div className="sticky top-0 z-20 flex border-b border-line bg-raised text-xs text-muted">
                <div className="sticky left-0 z-10 shrink-0 bg-raised px-4 py-2 font-medium" style={{ width: UNIT_PX }}>
                  Unit
                </div>
                {d.days.map((day) => (
                  <div key={day} className={cn('shrink-0 py-2 text-center', day === d.today && 'font-semibold text-accent-text', day.endsWith('-01') && 'border-l border-line-strong')} style={{ width: DAY_PX }}>
                    {day.endsWith('-01') || day === d.days[0] ? shortDay(day) : weekdayDay(day)}
                  </div>
                ))}
              </div>
              {villas.map((villa) => (
                <div key={villa.id}>
                  <div className="flex border-b border-line">
                    <Link to={`/property/villas/${villa.id}`} className="sticky left-0 z-10 bg-card px-4 py-1.5 text-xs font-semibold tracking-wider text-subtle uppercase hover:text-fg">
                      {villa.name}
                    </Link>
                  </div>
                  {d.rows
                    .filter((r) => r.place.villa.id === villa.id)
                    .map((row) => (
                      <div key={row.place.unit.id} className="flex border-b border-line last:border-b-0">
                        <Link to={`/property/units/${row.place.unit.id}`} className="sticky left-0 z-10 flex shrink-0 items-center gap-2 bg-card px-4 text-sm font-medium hover:underline" style={{ width: UNIT_PX, height: 44 }}>
                          <span className="font-mono">{row.place.unit.code}</span>
                        </Link>
                        <div className="relative flex" style={{ width: days * DAY_PX, height: 44 }}>
                          {d.days.map((day, i) => {
                            const state = row.states[i] ?? 'free'
                            const cell = cn('h-full shrink-0 border-l border-line', day === d.today && 'bg-accent-soft/40', state === 'closed' && NIGHT_CLASS.closed)
                            return state === 'free' ? (
                              <Link
                                key={day}
                                to={`/bookings/new?unit=${row.place.unit.id}&checkIn=${day}&checkOut=${addDays(day, 1)}`}
                                aria-label={`Book ${row.place.unit.code} on ${shortDay(day)}`}
                                className={cn(cell, 'transition-colors hover:bg-raised')}
                                style={{ width: DAY_PX }}
                              />
                            ) : (
                              <span key={day} aria-hidden className={cell} style={{ width: DAY_PX }} />
                            )
                          })}
                          {row.spans.map((span) => (
                            <Link
                              key={`${span.kind}-${span.id}`}
                              to={span.kind === 'booking' ? `/bookings/${span.id}` : `/property/units/${row.place.unit.id}`}
                              title={span.kind === 'block' ? `${BLOCK_REASON_LABEL[span.status as BlockReason]}: ${span.label}` : span.label}
                              className={cn(
                                'absolute top-2 bottom-2 flex items-center overflow-hidden border px-2 text-xs font-medium whitespace-nowrap transition-[filter] hover:brightness-95',
                                span.clippedStart ? 'rounded-l-sm' : 'rounded-l-full',
                                span.clippedEnd ? 'rounded-r-sm' : 'rounded-r-full',
                                span.kind === 'block' && 'hatch border-line-strong bg-control text-muted',
                                span.kind === 'booking' && span.status === 'checked_in' && 'border-l-4',
                              )}
                              style={{ left: span.start * DAY_PX + 4, width: span.length * DAY_PX - 8, ...spanStyle(span) }}
                            >
                              <span className="truncate">{span.kind === 'block' ? BLOCK_REASON_LABEL[span.status as BlockReason] : span.label}</span>
                            </Link>
                          ))}
                        </div>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
