import { Link, useSearchParams } from 'react-router'
import { BedDouble, Search, UserPlus } from 'lucide-react'
import type { RackTile } from '@/application/hotelDesk'
import { HOUSEKEEPING_STATES, type HousekeepingState } from '@/domain/maintenance'
import { OCCUPANCIES, OCCUPANCY_LABEL, RACK_HK_LABEL, type Occupancy } from '@/domain/rack'
import { floorLabel } from '@/domain/section'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, type Tone } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { HOUSEKEEPING_TONE } from '../maintenance/tones'

type OccupancyFilter = 'all' | Occupancy

const OCCUPANCY_TONE: Record<Occupancy, Tone> = { vacant: 'success', arriving: 'info', in_house: 'neutral', due_out: 'warning', departed: 'neutral' }
const TILE: Record<Occupancy, string> = { vacant: 'bg-success-soft', arriving: 'bg-info-soft', in_house: 'bg-raised', due_out: 'bg-warning-soft', departed: 'bg-raised' }

/** Where a tile leads: the stay it shows, else the room. */
const tileLink = (t: RackTile) => (t.stay ? `/bookings/${t.stay.id}` : `/property/units/${t.unit.id}`)

/**
 * The room rack: a hotel's rooms by floor for one date, each with its occupancy, housekeeping state
 * and guest. Filters live in the URL. A vacant room today starts a walk-in; a stay still waiting for
 * a room opens its booking to assign one.
 */
export default function RoomRackPage() {
  const { desk } = useServices()
  const [params, setParams] = useSearchParams()
  const villaId = params.get('villa') ?? ''
  const date = params.get('date') ?? ''
  const data = useResource(`desk.rack:${villaId}:${date}`, () => desk.rack(villaId || undefined, date || undefined))
  const occupancy = (params.get('occupancy') ?? 'all') as OccupancyFilter
  const floor = params.get('floor')
  const roomType = params.get('type') ?? ''
  const hk = (params.get('hk') ?? '') as HousekeepingState | ''
  const query = (params.get('q') ?? '').trim().toLowerCase()

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const isToday = d.date === d.today
  const set = (k: string, v: string) => {
    const search = new URLSearchParams(params)
    if (v && v !== 'all') search.set(k, v)
    else search.delete(k)
    setParams(search, { replace: true })
  }
  // Every filter but occupancy narrows the tiles the chips count.
  const narrowed = d.tiles.filter(
    (t) =>
      (floor === null || t.floor === floor) &&
      (!roomType || t.roomType === roomType) &&
      (!hk || t.housekeeping === hk) &&
      (!query || t.unit.code.toLowerCase().includes(query) || (t.stay?.guestName ?? '').toLowerCase().includes(query) || (t.next?.guestName ?? '').toLowerCase().includes(query)),
  )
  const shown = narrowed.filter((t) => occupancy === 'all' || t.occupancy === occupancy)
  const floors = d.floors.map((f) => ({ ...f, tiles: shown.filter((t) => t.floor === f.floor) })).filter((f) => f.tiles.length > 0)
  const hkCount = (s: HousekeepingState) => d.tiles.filter((t) => t.housekeeping === s).length

  return (
    <div className="space-y-4">
      <Card className="p-0">
        <TableToolbar
          chips={[{ value: 'all' as OccupancyFilter, label: 'All', count: narrowed.length }, ...OCCUPANCIES.map((o) => ({ value: o as OccupancyFilter, label: OCCUPANCY_LABEL[o], count: narrowed.filter((t) => t.occupancy === o).length }))]}
          chip={occupancy}
          onChip={(o) => set('occupancy', o)}
          chipLabel="Occupancy"
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Room or guest" aria-label="Search rooms" value={params.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} />}
          date={<Input type="date" aria-label="Date" className="h-10 w-44" value={d.date} onChange={(e) => set('date', e.target.value === d.today ? '' : e.target.value)} />}
          filters={
            <>
              {d.properties.length > 1 && <Select aria-label="Property" value={d.villa.id} options={d.properties.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => set('villa', e.target.value)} />}
              <Select aria-label="Floor" value={floor ?? 'all'} options={[{ value: 'all', label: 'Every floor' }, ...d.floors.map((f) => ({ value: f.floor, label: `${f.label} (${f.count})` }))]} onChange={(e) => set('floor', e.target.value)} />
              {d.roomTypes.length > 1 && <Select aria-label="Room type" value={roomType} options={[{ value: '', label: 'Every room type' }, ...d.roomTypes.map((r) => ({ value: r.name, label: `${r.name} (${r.count})` }))]} onChange={(e) => set('type', e.target.value)} />}
              {isToday && <Select aria-label="Housekeeping" value={hk} options={[{ value: '', label: 'Any housekeeping' }, ...HOUSEKEEPING_STATES.map((s) => ({ value: s, label: `${RACK_HK_LABEL[s]} (${hkCount(s)})` }))]} onChange={(e) => set('hk', e.target.value)} />}
            </>
          }
          active={[...params.keys()].some((k) => k !== 'villa')}
          onClear={() => setParams(villaId ? { villa: villaId } : {}, { replace: true })}
          summary={`${plural(shown.length, 'room')} of ${d.tiles.length} · ${d.villa.name} · ${isToday ? 'today' : shortDay(d.date)}`}
        />
      </Card>

      {d.unassigned.length > 0 && (
        <Card aria-labelledby="rack-assign" className="ring-2 ring-warning">
          <CardHeader id="rack-assign" title="Arrivals without a room" />
          <ul className="divide-y divide-line">
            {d.unassigned.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-fg">{u.guestName}</span>
                  <span className="block text-xs text-muted">
                    <span className="font-mono">{u.code}</span> · {u.roomType} · out {shortDay(u.checkOut)}
                  </span>
                </span>
                <Link to={`/bookings/${u.id}`} className={buttonStyles({ variant: 'accent', size: 'sm' })}>
                  <BedDouble aria-hidden className="size-4" /> Assign room
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {floors.length === 0 ? (
        <Card>
          <EmptyState title="No room matches">Clear the filters to see every room.</EmptyState>
        </Card>
      ) : (
        floors.map((f) => (
          <Card key={f.floor || 'none'} aria-labelledby={`floor-${f.floor || 'none'}`}>
            <CardHeader id={`floor-${f.floor || 'none'}`} title={floorLabel(f.floor)} action={<span className="text-sm text-muted">{plural(f.tiles.length, 'room')}</span>} />
            <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              {f.tiles.map((t) => (
                <li key={t.unit.id} className={cn('flex flex-col rounded-panel text-sm', TILE[t.occupancy])}>
                  <Link to={tileLink(t)} className="flex flex-1 flex-col gap-1.5 rounded-panel p-3 transition-transform hover:-translate-y-0.5">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold">{t.unit.code}</span>
                      <StatusPill tone={OCCUPANCY_TONE[t.occupancy]}>{OCCUPANCY_LABEL[t.occupancy]}</StatusPill>
                    </span>
                    <span className="truncate text-xs text-muted">{t.roomType}</span>
                    <span className="truncate font-medium text-fg">{t.stay ? t.stay.guestName : 'No guest'}</span>
                    {t.stay && (
                      <span className="text-xs text-muted">
                        {shortDay(t.stay.checkIn)} to {shortDay(t.stay.checkOut)}
                      </span>
                    )}
                    {t.next && <span className="truncate text-xs text-muted">Then {t.next.guestName}</span>}
                    {t.housekeeping && (
                      <span>
                        <StatusPill tone={HOUSEKEEPING_TONE[t.housekeeping]}>{RACK_HK_LABEL[t.housekeeping]}</StatusPill>
                      </span>
                    )}
                  </Link>
                  {isToday && (t.occupancy === 'vacant' || t.occupancy === 'departed') && t.unit.status === 'active' && (
                    <Link to={`/bookings/new?unit=${t.unit.id}&walkin=1`} className="mx-3 mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent-text hover:underline">
                      <UserPlus aria-hidden className="size-3.5" /> Walk-in tonight
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  )
}
