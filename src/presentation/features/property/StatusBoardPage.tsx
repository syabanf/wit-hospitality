import { Link, useSearchParams } from 'react-router'
import { UNIT_STATUS_LABEL, UNIT_STATUSES, type UnitStatus } from '@/domain/property'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { plural } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Card, CardHeader } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { UNIT_STATUS_TONE } from '../shared/tones'

type Filter = 'all' | UnitStatus | 'overdue'

const TILE: Record<UnitStatus, string> = {
  active: 'bg-success-soft',
  cleaning: 'bg-info-soft',
  maintenance: 'bg-warning-soft',
  inactive: 'bg-raised',
}

/** Every unit as a tile per villa, coloured by status, with the reason, the return date and an Overdue badge. */
export default function StatusBoardPage() {
  const { property } = useServices()
  const data = useResource('property.statusBoard', () => property.statusBoard())
  const [params, setParams] = useSearchParams()
  const status = (params.get('status') ?? 'all') as Filter
  const locationId = params.get('location') ?? ''
  const villaId = params.get('villa') ?? ''

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const set = (k: string, v: string) => {
    const search = new URLSearchParams(params)
    if (v && v !== 'all') search.set(k, v)
    else search.delete(k)
    if (k === 'location') search.delete('villa')
    setParams(search, { replace: true })
  }
  const scoped = d.villas.filter((v) => (!locationId || v.location.id === locationId) && (!villaId || v.villa.id === villaId))
  const units = scoped.flatMap((v) => v.units)
  const matches = (u: (typeof units)[number]) => status === 'all' || (status === 'overdue' ? u.overdue : u.place.unit.status === status)
  const shown = scoped.map((v) => ({ ...v, units: v.units.filter(matches) })).filter((v) => v.units.length > 0)
  const count = (f: Filter) => (f === 'all' ? units.length : units.filter((u) => (f === 'overdue' ? u.overdue : u.place.unit.status === f)).length)
  const filters: Filter[] = ['all', ...UNIT_STATUSES, 'overdue']

  return (
    <div className="space-y-4">
      <Card className="p-0">
        <TableToolbar
          chips={filters.map((f) => ({ value: f, label: f === 'all' ? 'All' : f === 'overdue' ? 'Overdue' : UNIT_STATUS_LABEL[f], count: count(f) }))}
          chip={status}
          onChip={(f) => set('status', f)}
          filters={
            <>
              <Select aria-label="Location" value={locationId} options={[{ value: '', label: 'Every location' }, ...d.locations.map((l) => ({ value: l.id, label: l.name }))]} onChange={(e) => set('location', e.target.value)} />
              <Select aria-label="Villa" value={villaId} options={[{ value: '', label: 'Every villa' }, ...d.villas.filter((v) => !locationId || v.location.id === locationId).map((v) => ({ value: v.villa.id, label: v.villa.name }))]} onChange={(e) => set('villa', e.target.value)} />
            </>
          }
          active={params.size > 0}
          onClear={() => setParams({}, { replace: true })}
          summary={`${plural(shown.reduce((n, v) => n + v.units.length, 0), 'unit')} of ${units.length}`}
        />
      </Card>
      {shown.length === 0 ? (
        <Card>
          <EmptyState title="No unit matches">Clear the filters to see every unit.</EmptyState>
        </Card>
      ) : (
        shown.map((v) => (
          <Card key={v.villa.id} aria-labelledby={`board-${v.villa.id}`}>
            <CardHeader
              id={`board-${v.villa.id}`}
              title={v.villa.name}
              action={
                <Link to={`/property/villas/${v.villa.id}`} className="text-sm text-accent-text hover:underline">
                  {v.location.name}
                </Link>
              }
            />
            <ul className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
              {v.units.map(({ place: { unit }, overdue, since }) => (
                <li key={unit.id}>
                  <Link to={`/property/units/${unit.id}`} className={cn('flex h-full flex-col gap-1.5 rounded-panel p-3 text-sm transition-transform hover:-translate-y-0.5', TILE[unit.status], overdue && 'ring-2 ring-danger')}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono font-semibold">{unit.code}</span>
                      <span className="flex gap-1">
                        {overdue && <StatusPill tone="danger">Overdue</StatusPill>}
                        <StatusPill tone={UNIT_STATUS_TONE[unit.status]}>{UNIT_STATUS_LABEL[unit.status]}</StatusPill>
                      </span>
                    </span>
                    <span className="truncate text-xs text-muted">{unit.name}</span>
                    {unit.statusReason && <span className="text-fg">{unit.statusReason}</span>}
                    {(unit.statusUntil || (unit.status !== 'active' && since)) && (
                      <span className={cn('text-xs', overdue ? 'font-medium text-danger' : 'text-muted')}>
                        {unit.statusUntil ? `${overdue ? 'Was due back' : 'Back by'} ${shortDay(unit.statusUntil)}` : ''}
                        {unit.statusUntil && unit.status !== 'active' && since ? ' · ' : ''}
                        {unit.status !== 'active' && since ? `since ${shortDay(since)}` : ''}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ))
      )}
    </div>
  )
}
