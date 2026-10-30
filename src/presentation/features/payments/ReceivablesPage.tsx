import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Link2, Search } from 'lucide-react'
import type { ReceivableRow } from '@/application/views'
import { AGING_BUCKETS, AGING_LABEL, type AgingBucket } from '@/domain/payment'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { ScopePicker } from '../shared/ScopePicker'
import { AGING_TONE } from './tones'

type Chip = AgingBucket | 'all' | 'late'

/** Direct stays that still owe money, oldest due first, with a one-click QRIS link. */
export default function ReceivablesPage() {
  const { payments } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('payments.receivables', () => payments.receivables())
  const [params, setParams] = useSearchParams()
  const [busy, setBusy] = useState<string | null>(null)
  const chip = ((params.get('late') ? 'late' : params.get('aging')) ?? 'all') as Chip
  const q = (params.get('q') ?? '').toLowerCase()
  const scope = { locationId: params.get('location') || undefined, villaId: params.get('villa') || undefined, unitId: params.get('unit') || undefined }

  function update(next: Record<string, string | undefined>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  async function sendLink(r: ReceivableRow) {
    setBusy(r.booking.id)
    try {
      const link = await payments.createLink({ bookingId: r.booking.id, kind: 'balance', method: 'qris', amount: r.outstanding, payer: r.booking.guestName })
      toast({ title: `QRIS link sent to ${r.booking.guestName}`, description: `/pay/${link.token}` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not create the link', description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const scoped = d.rows.filter((r) => (scope.unitId ? r.booking.unitId === scope.unitId : scope.villaId ? r.booking.place.villa.id === scope.villaId : scope.locationId ? r.booking.place.location.id === scope.locationId : true)).filter((r) => !q || [r.booking.code, r.booking.guestName, r.booking.unitCode].some((v) => v.toLowerCase().includes(q)))
  const rows = scoped.filter((r) => (chip === 'all' ? true : chip === 'late' ? r.bucket !== 'not_due' : r.bucket === chip))
  const sumOf = (list: readonly ReceivableRow[]) => list.reduce((s, r) => s + r.outstanding, 0)

  return (
    <div className="space-y-4">
      <p className="max-w-xl text-sm text-muted">
        The balance falls due {d.policy.balanceDueDays} days before arrival. A link gives the guest QRIS, a virtual account or card; the money lands in the bank for approval.
      </p>
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {AGING_BUCKETS.map((b) => {
          const mine = scoped.filter((r) => r.bucket === b)
          return <StatTile key={b} label={AGING_LABEL[b]} value={money(sumOf(mine))} hint={`${mine.length} bookings`} active={chip === b} onClick={() => update({ aging: chip === b ? undefined : b, late: undefined })} />
        })}
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={(['all', 'late', ...AGING_BUCKETS] as Chip[]).map((c) => ({ value: c, label: c === 'all' ? 'All' : c === 'late' ? 'Late' : AGING_LABEL[c], count: c === 'all' ? scoped.length : c === 'late' ? scoped.filter((r) => r.bucket !== 'not_due').length : scoped.filter((r) => r.bucket === c).length }))}
          chip={chip}
          onChip={(c) => update({ aging: c === 'all' || c === 'late' ? undefined : c, late: c === 'late' ? '1' : undefined })}
          summary={`${money(sumOf(rows))} in ${rows.length} bookings`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Booking, guest or unit" aria-label="Search receivables" value={params.get('q') ?? ''} onChange={(e) => update({ q: e.target.value })} />}
          filters={<ScopePicker catalog={d.catalog} value={scope} onChange={(sc) => update({ location: sc.locationId, villa: sc.villaId, unit: sc.unitId })} className="flex min-w-0 flex-1 basis-80 gap-2" />}
          active={params.size > 0}
          onClear={() => setParams({}, { replace: true })}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="Receivables"
            rows={rows}
            rowKey={(r) => r.booking.id}
            href={(r) => `/bookings/${r.booking.id}`}
            defaultSort={{ key: 'due', dir: 'asc' }}
            exportName="receivables"
            exportDate={d.today}
            empty={<EmptyState title="Nothing owed here">Every stay in this view is paid.</EmptyState>}
            columns={[
              { key: 'guest', header: 'Guest', cell: (r) => r.booking.guestName, value: (r) => r.booking.guestName },
              { key: 'code', header: 'Booking', cell: (r) => <span className="font-mono text-xs">{r.booking.code}</span>, value: (r) => r.booking.code, hide: 'lg' },
              { key: 'in', header: 'Check-in', cell: (r) => shortDay(r.booking.checkIn), value: (r) => r.booking.checkIn, hide: 'lg' },
              { key: 'due', header: 'Due', cell: (r) => shortDay(r.dueOn), value: (r) => r.dueOn },
              { key: 'aging', header: 'Aging', cell: (r) => <StatusPill tone={AGING_TONE[r.bucket]}>{AGING_LABEL[r.bucket]}</StatusPill>, value: (r) => r.bucket },
              { key: 'paid', header: 'Paid', align: 'right', cell: (r) => <span className="tabular">{money(r.paid)}</span>, value: (r) => r.paid, total: (s) => money(s), hide: 'xl' },
              { key: 'out', header: 'Outstanding', align: 'right', cell: (r) => <span className="font-semibold tabular">{money(r.outstanding)}</span>, value: (r) => r.outstanding, total: (s) => money(s) },
              {
                key: 'act',
                header: '',
                align: 'right',
                cell: (r) =>
                  r.pendingLink ? (
                    <Tag tone="warning">Link sent</Tag>
                  ) : (
                    can('payments', 'create') && (
                      <span onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="soft" loading={busy === r.booking.id} onClick={() => void sendLink(r)}>
                          <Link2 aria-hidden className="size-3.5" /> Send link
                        </Button>
                      </span>
                    )
                  ),
              },
            ]}
            card={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.booking.guestName}</p>
                  <p className="truncate text-xs text-muted">
                    {r.booking.code} · due {shortDay(r.dueOn)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <span className="text-sm font-semibold tabular">{money(r.outstanding)}</span>
                  <StatusPill tone={AGING_TONE[r.bucket]}>{AGING_LABEL[r.bucket]}</StatusPill>
                </div>
              </div>
            )}
          />
        </div>
      </Card>
      {d.drafts.length > 0 && (
        <Card aria-labelledby="drafts-title">
          <CardHeader id="drafts-title" title={`Drafts without a deposit after ${d.policy.autoCancelDays} days`} />
          <ul className="stagger divide-y divide-line text-sm">
            {d.drafts.map((b) => (
              <li key={b.id}>
                <Link to={`/bookings/${b.id}`} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate">
                    {b.guestName} · {b.code} · {b.unitCode}
                  </span>
                  <Tag tone="accent">Cancel or chase</Tag>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
