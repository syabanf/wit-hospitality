import { Link, useSearchParams } from 'react-router'
import { Search } from 'lucide-react'
import type { KeyRow } from '@/application/frontDesk'
import { KEY_KIND_LABEL, KEY_REASON_LABEL, KEY_STATUS_LABEL, type KeyStatus } from '@/domain/frontDesk'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'

type StatusFilter = 'all' | KeyStatus
const STATUSES: readonly KeyStatus[] = ['out', 'returned', 'lost', 'not_returned']
const TONE = { out: 'warning', returned: 'success', lost: 'danger', not_returned: 'danger' } as const
const stamp = (at: string) => `${shortDay(at.slice(0, 10))}, ${at.slice(11, 16)}`

function KeyRows({ rows, empty }: { rows: readonly KeyRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {rows.map((r) => (
        <li key={`${r.bookingId}:${r.key.id}`}>
          <Link to={`/bookings/${r.bookingId}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-2 py-3 text-sm hover:bg-raised">
            <span className="min-w-20 font-mono font-medium">{r.key.number}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {r.unitCode} · {r.guestName}
              </span>
              <span className="block truncate text-xs text-muted">
                {r.code} · {KEY_KIND_LABEL[r.key.kind]} · {KEY_REASON_LABEL[r.key.reason]} by {r.key.issuedBy} {stamp(r.key.issuedAt)}
                {r.key.closedAt && ` · ${KEY_STATUS_LABEL[r.key.status].toLowerCase()} ${stamp(r.key.closedAt)}`}
                {r.key.charge > 0 && ` · ${money(r.key.charge)} charged`}
              </span>
            </span>
            <StatusPill tone={TONE[r.key.status]}>{KEY_STATUS_LABEL[r.key.status]}</StatusPill>
          </Link>
        </li>
      ))}
    </ul>
  )
}

/** Keys out now at one property and every key handed out, newest first; each row opens its stay. */
export default function KeyLogPage() {
  const { frontDesk } = useServices()
  const [params, setParams] = useSearchParams()
  const villaId = params.get('villa') ?? ''
  const data = useResource(`frontDesk.keyLog:${villaId}`, () => frontDesk.keyLog(villaId || undefined))
  const status = (params.get('status') ?? 'all') as StatusFilter
  const query = (params.get('q') ?? '').trim().toLowerCase()

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const set = (k: string, v: string) => {
    const search = new URLSearchParams(params)
    if (v && v !== 'all') search.set(k, v)
    else search.delete(k)
    setParams(search, { replace: true })
  }
  const matches = (r: KeyRow) => !query || [r.key.number, r.unitCode, r.guestName, r.code].some((x) => x.toLowerCase().includes(query))
  const narrowed = d.history.filter(matches)
  const shown = narrowed.filter((r) => status === 'all' || r.key.status === status)

  return (
    <div className="space-y-4">
      <Card aria-labelledby="keys-out-title">
        <CardHeader id="keys-out-title" title={`Out now at ${d.villa.name}`} />
        <KeyRows rows={d.out.filter(matches)} empty="Every key handed out has come back." />
      </Card>
      <Card className="p-0" aria-label="Key history">
        <TableToolbar
          chips={[{ value: 'all' as StatusFilter, label: 'All', count: narrowed.length }, ...STATUSES.map((x) => ({ value: x as StatusFilter, label: KEY_STATUS_LABEL[x], count: narrowed.filter((r) => r.key.status === x).length }))]}
          chip={status}
          onChip={(x) => set('status', x)}
          chipLabel="Key status"
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Key, room, guest or booking" aria-label="Search keys" value={params.get('q') ?? ''} onChange={(e) => set('q', e.target.value)} />}
          filters={d.villas.length > 1 ? <Select aria-label="Property" value={d.villa.id} options={d.villas.map((v) => ({ value: v.id, label: v.name }))} onChange={(e) => set('villa', e.target.value)} /> : null}
          active={status !== 'all' || Boolean(query)}
          onClear={() => setParams(villaId ? { villa: villaId } : {}, { replace: true })}
        />
        <div className="p-5 pt-2">{shown.length === 0 ? <EmptyState title="No key matches">Clear the filters to see every key.</EmptyState> : <KeyRows rows={shown} empty="" />}</div>
      </Card>
    </div>
  )
}
