import { useSearchParams } from 'react-router'
import { Search } from 'lucide-react'
import type { PaymentView } from '@/application/views'
import { PAYMENT_KIND_LABEL, PAYMENT_KINDS, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, PAYMENT_STATUS_LABEL, PAYMENT_STATUSES, type PaymentKind, type PaymentMethod, type PaymentStatus } from '@/domain/payment'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Card } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { ScopePicker } from '../shared/ScopePicker'
import { PAYMENT_TONE } from './tones'

type StatusChip = PaymentStatus | 'all'
const signed = (p: PaymentView) => (p.kind === 'refund' ? -p.amount : p.amount)

/** Every payment with its booking and ledger entry; filters live in the URL. */
export default function PaymentsListPage() {
  const { payments, clock } = useServices()
  const data = useResource('payments.list', () => payments.list())
  const [params, setParams] = useSearchParams()
  const get = (k: string) => params.get(k) ?? ''
  const status = (PAYMENT_STATUSES.find((x) => x === get('status')) ?? 'all') as StatusChip
  const method = (PAYMENT_METHODS.find((x) => x === get('method')) ?? '') as PaymentMethod | ''
  const kind = (PAYMENT_KINDS.find((x) => x === get('kind')) ?? '') as PaymentKind | ''
  const scope = { locationId: get('location') || undefined, villaId: get('villa') || undefined, unitId: get('unit') || undefined }

  function update(next: Record<string, string | undefined>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v && v !== 'all') search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const inScope = d.list.filter((p) => {
    if (scope.unitId) return d.catalog.unitByCode(p.unitCode).id === scope.unitId
    if (scope.villaId) return p.villaId === scope.villaId
    if (scope.locationId) return p.locationId === scope.locationId
    return true
  })
  const base = payments.filter(inScope, { method, kind, query: get('q'), from: get('from') || undefined, to: get('to') || undefined })
  const rows = status === 'all' ? base : base.filter((p) => p.status === status)
  const paid = rows.filter((p) => p.status === 'paid' || p.status === 'refunded')

  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Collected" value={money(paid.filter((p) => p.kind !== 'refund').reduce((s, p) => s + p.amount, 0))} hint="In the rows below" active={status === 'paid'} onClick={() => update({ status: status === 'paid' ? 'all' : 'paid' })} />
        <StatTile label="Waiting" value={rows.filter((p) => p.status === 'pending').length} hint="Links not yet paid" active={status === 'pending'} onClick={() => update({ status: status === 'pending' ? 'all' : 'pending' })} />
        <StatTile label="Refunded" value={money(rows.filter((p) => p.kind === 'refund').reduce((s, p) => s + p.amount, 0))} active={kind === 'refund'} onClick={() => update({ kind: kind === 'refund' ? '' : 'refund' })} />
        <StatTile label="Gateway fees" value={money(paid.reduce((s, p) => s + p.gatewayFee, 0))} hint="Booked as cash-out" />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={(['all', ...PAYMENT_STATUSES] as StatusChip[]).map((x) => ({ value: x, label: x === 'all' ? 'All' : PAYMENT_STATUS_LABEL[x], count: x === 'all' ? base.length : base.filter((p) => p.status === x).length }))}
          chip={status}
          onChip={(x) => update({ status: x })}
          summary={`${rows.length} of ${d.list.length} payments`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Payment, booking, guest or reference" aria-label="Search payments" value={get('q')} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Method" value={method} options={[{ value: '', label: 'Every method' }, ...PAYMENT_METHODS.map((m) => ({ value: m, label: PAYMENT_METHOD_LABEL[m] }))]} onChange={(e) => update({ method: e.target.value })} />
              <Select aria-label="Kind" value={kind} options={[{ value: '', label: 'Every kind' }, ...PAYMENT_KINDS.map((k) => ({ value: k, label: PAYMENT_KIND_LABEL[k] }))]} onChange={(e) => update({ kind: e.target.value })} />
              <ScopePicker catalog={d.catalog} value={scope} onChange={(sc) => update({ location: sc.locationId, villa: sc.villaId, unit: sc.unitId })} className="flex min-w-0 flex-1 basis-80 gap-2" />
            </>
          }
          date={<DateRangeFilter today={clock.today()} label="Paid" value={{ from: get('from') || undefined, to: get('to') || undefined }} onChange={(r) => update({ from: r.from, to: r.to })} />}
          active={params.size > 0}
          onClear={() => setParams({}, { replace: true })}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="Payments"
            rows={rows}
            rowKey={(p) => p.id}
            href={(p) => `/bookings/${p.bookingId}`}
            defaultSort={{ key: 'date', dir: 'desc' }}
            exportName="payments"
            exportDate={d.today}
            empty={<EmptyState title="No payment matches">Clear a filter to see more.</EmptyState>}
            columns={[
              { key: 'guest', header: 'Guest', cell: (p) => p.guestName, value: (p) => p.guestName },
              { key: 'no', header: 'Payment', cell: (p) => <span className="font-mono text-xs">{p.number}</span>, value: (p) => p.number, hide: 'lg' },
              { key: 'booking', header: 'Booking', cell: (p) => <span className="font-mono text-xs">{p.bookingCode}</span>, value: (p) => p.bookingCode, hide: 'xl' },
              { key: 'date', header: 'Date', cell: (p) => shortDay(p.paidOn ?? p.createdOn), value: (p) => p.paidOn ?? p.createdOn },
              { key: 'kind', header: 'Kind', cell: (p) => PAYMENT_KIND_LABEL[p.kind], value: (p) => PAYMENT_KIND_LABEL[p.kind], hide: 'lg' },
              { key: 'method', header: 'Method', cell: (p) => PAYMENT_METHOD_LABEL[p.method], value: (p) => PAYMENT_METHOD_LABEL[p.method] },
              { key: 'villa', header: 'Villa', cell: (p) => p.villaName, value: (p) => p.villaName, hide: 'xl' },
              { key: 'entry', header: 'Ledger', cell: (p) => (p.transactionStatus ? TRANSACTION_STATUS_LABEL[p.transactionStatus] : 'Before console'), value: (p) => p.transactionStatus ?? '', hide: 'xl' },
              { key: 'status', header: 'Status', cell: (p) => <StatusPill tone={PAYMENT_TONE[p.status]}>{PAYMENT_STATUS_LABEL[p.status]}</StatusPill>, value: (p) => PAYMENT_STATUS_LABEL[p.status] },
              { key: 'amount', header: 'Amount', align: 'right', cell: (p) => <span className="font-semibold tabular">{p.kind === 'refund' ? '-' : ''}{money(p.amount)}</span>, value: signed, total: (sum) => money(sum) },
            ]}
            card={(p) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.guestName}</p>
                  <p className="truncate text-xs text-muted">
                    {shortDay(p.paidOn ?? p.createdOn)} · {PAYMENT_METHOD_LABEL[p.method]} · {p.number}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <span className="text-sm font-semibold tabular">{p.kind === 'refund' ? '-' : ''}{money(p.amount)}</span>
                  <StatusPill tone={PAYMENT_TONE[p.status]}>{PAYMENT_STATUS_LABEL[p.status]}</StatusPill>
                </div>
              </div>
            )}
          />
        </div>
      </Card>
    </div>
  )
}
