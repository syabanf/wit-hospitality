import type { UnitRow } from '@/application/views'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { StatusPill, Tag } from '../../ui/Badge'
import { ListTable, type Column } from '../../ui/ListTable'
import { EmptyState } from '../../ui/States'
import { NIGHT_LABEL, NIGHT_TONE } from '../shared/tones'

/** Units with tonight's state, listing and next arrival. `place` adds villa and location columns for cross-villa lists. */
export function UnitTable({ rows, label, place = false, exportName, exportDate }: { rows: readonly UnitRow[]; label: string; place?: boolean; exportName?: string; exportDate?: string }) {
  const placeColumns: Column<UnitRow>[] = place
    ? [
        { key: 'villa', header: 'Villa', cell: (r) => r.place.villa.name, value: (r) => r.place.villa.name },
        { key: 'loc', header: 'Location', cell: (r) => r.place.location.name, value: (r) => r.place.location.name, hide: 'lg' },
      ]
    : []
  return (
    <ListTable
      label={label}
      rows={rows}
      rowKey={(r) => r.place.unit.id}
      href={(r) => `/property/units/${r.place.unit.id}`}
      defaultSort={{ key: 'code', dir: 'asc' }}
      exportName={exportName}
      exportDate={exportDate}
      empty={<EmptyState title="No units" />}
      columns={[
        { key: 'code', header: 'Unit', cell: (r) => <span className="font-mono">{r.place.unit.code}</span>, value: (r) => r.place.unit.code },
        { key: 'name', header: 'Name', cell: (r) => r.place.unit.name, value: (r) => r.place.unit.name },
        ...placeColumns,
        { key: 'group', header: 'Group', cell: (r) => r.place.group?.name ?? 'None', value: (r) => r.place.group?.name ?? '', hide: 'lg' },
        { key: 'tonight', header: 'Tonight', cell: (r) => <StatusPill tone={NIGHT_TONE[r.tonight]}>{NIGHT_LABEL[r.tonight]}</StatusPill>, value: (r) => NIGHT_LABEL[r.tonight] },
        { key: 'listing', header: 'Airbnb', cell: (r) => (r.listing ? <Tag tone={r.listing.status === 'active' ? 'success' : 'neutral'}>{r.account?.name}</Tag> : <span className="text-muted">Direct only</span>), value: (r) => r.account?.name ?? 'Direct only', hide: 'lg' },
        { key: 'next', header: 'Next arrival', cell: (r) => (r.nextArrival ? `${shortDay(r.nextArrival.checkIn)} · ${r.nextArrival.guestName}` : <span className="text-muted">None</span>), value: (r) => r.nextArrival?.checkIn ?? '' },
        { key: 'rate', header: 'Rate', align: 'right', cell: (r) => <span className="tabular">{money(r.place.unit.nightlyRate)}</span>, value: (r) => r.place.unit.nightlyRate },
      ]}
      card={(r) => (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono font-semibold">{r.place.unit.code}</p>
            <p className="text-xs text-muted">
              {place ? `${r.place.villa.name} · ` : ''}
              {r.nextArrival ? `Next ${shortDay(r.nextArrival.checkIn)} · ${r.nextArrival.guestName}` : 'No arrival planned'}
            </p>
          </div>
          <StatusPill tone={NIGHT_TONE[r.tonight]}>{NIGHT_LABEL[r.tonight]}</StatusPill>
        </div>
      )}
    />
  )
}
