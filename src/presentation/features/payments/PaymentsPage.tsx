import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowRight, List, Settings2 } from 'lucide-react'
import { AGING_LABEL, PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from '@/domain/payment'
import { shortDay } from '@/lib/dates'
import { money, moneyCompact } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { seriesColor } from '../../charts/colors'
import { GroupedColumns } from '../../charts/GroupedColumns'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { DonutLegend } from '../reports/DonutLegend'
import { METHOD_SLOT, PAYMENT_TONE } from './tones'

/** Money from guests and Airbnb: collected, owed, late, and the links still open. */
export default function PaymentsPage() {
  const { payments } = useServices()
  const data = useResource('payments.overview', () => payments.overview())
  const [bucket, setBucket] = useState<string | null>(null)
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const agingKey = bucket ?? d.aging.find((a) => a.amount > 0)?.bucket ?? 'not_due'
  const agingRow = d.aging.find((a) => a.bucket === agingKey)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Every rupiah a guest pays lands as a cash-in for approval: cash in the location cashbox, everything else in the bank.</p>
        <div className="flex flex-wrap gap-2">
          <Link to="/payments/settings" className={buttonStyles({ variant: 'card' })}>
            <Settings2 aria-hidden className="size-4" /> Policy
          </Link>
          <Link to="/payments/list" className={buttonStyles({ variant: 'accent' })}>
            <List aria-hidden className="size-4" /> All payments
          </Link>
        </div>
      </div>
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 min-[1600px]:grid-cols-5">
        <StatTile label="Collected this month" value={money(d.collectedMonth)} hint="Guests and Airbnb" to="/payments/list?status=paid" />
        <StatTile label="Outstanding" value={money(d.outstanding)} hint="Still owed on live stays" to="/payments/receivables" />
        <StatTile label="Overdue" value={d.overdue.length} hint={money(d.overdue.reduce((s, r) => s + r.outstanding, 0))} to="/payments/receivables?late=1" />
        <StatTile label="Links waiting" value={d.pendingLinks.length} hint={money(d.pendingLinks.reduce((s, l) => s + l.amount, 0))} to="/payments/list?status=pending" />
        <StatTile label="Refunds this month" value={money(d.refundsMonth)} hint="Money sent back" to="/payments/list?kind=refund" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card aria-labelledby="pw-title">
          <CardHeader id="pw-title" title="Collected per week" />
          {d.methods.length === 0 ? (
            <p className="text-sm text-muted">No payment collected yet.</p>
          ) : (
            <>
              <GroupedColumns
                className="h-60"
                label="Collected per week by method"
                labels={d.weeks.map((w) => w.label)}
                series={d.methods.map((m) => ({ id: m, label: PAYMENT_METHOD_LABEL[m], color: seriesColor(METHOD_SLOT[m]) }))}
                values={d.methods.map((_, i) => d.weeks.map((w) => w.byMethod[i] ?? 0))}
                format={moneyCompact}
              />
              <ul className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                {d.methods.map((m) => (
                  <li key={m} className="flex items-center gap-1.5">
                    <span aria-hidden className="size-2 rounded-full" style={{ background: seriesColor(METHOD_SLOT[m]) }} />
                    {PAYMENT_METHOD_LABEL[m]}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        <Card aria-labelledby="mix-title">
          <CardHeader id="mix-title" title="Method mix, 30 days" />
          <DonutLegend label="Collected by method" format={moneyCompact} slices={d.mix.map((x) => ({ id: x.method, label: PAYMENT_METHOD_LABEL[x.method], value: x.amount, color: seriesColor(METHOD_SLOT[x.method]) }))} />
        </Card>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card aria-labelledby="aging-title">
          <CardHeader id="aging-title" title="Receivables aging" action={<Link to="/payments/receivables" className="flex items-center gap-1 text-sm text-accent-text hover:underline">Receivables <ArrowRight aria-hidden className="size-4" /></Link>} />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
            <ColumnChart className="h-48" label="Outstanding by age" data={d.aging.map((a) => ({ key: a.bucket, label: AGING_LABEL[a.bucket], value: a.amount }))} selected={agingKey} onSelect={setBucket} format={money} tick={moneyCompact} showAxis={false} />
            <div className="rounded-panel bg-raised p-4">
              <p className="text-xs text-muted">{agingRow ? AGING_LABEL[agingRow.bucket] : ''}</p>
              <p className="mt-1 text-xl font-medium break-words tabular">{money(agingRow?.amount ?? 0)}</p>
              <p className="mt-1 text-xs text-muted">{agingRow?.count ?? 0} bookings</p>
            </div>
          </div>
        </Card>
        <Card aria-labelledby="links-title">
          <CardHeader id="links-title" title="Links about to expire" />
          {d.expiring.length === 0 ? (
            <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">No link is waiting.</p>
          ) : (
            <ul className="stagger divide-y divide-line">
              {d.expiring.map((l) => (
                <li key={l.token} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0 text-sm">
                  <span className="min-w-0 flex-1">
                    <Link to={`/bookings/${l.bookingId}`} className="block truncate font-medium hover:underline">
                      {PAYMENT_METHOD_LABEL[l.method]} · {money(l.amount)}
                    </Link>
                    <span className="block truncate text-xs text-muted">Expires {l.expiresAt.replace('T', ' ').slice(0, 16)}</span>
                  </span>
                  <Link to={`/pay/${l.token}`} className={buttonStyles({ variant: 'soft', size: 'sm' })}>
                    Guest view
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card aria-labelledby="recent-pay">
        <CardHeader id="recent-pay" title="Latest payments" action={<Link to="/payments/list" className="flex items-center gap-1 text-sm text-accent-text hover:underline">All <ArrowRight aria-hidden className="size-4" /></Link>} />
        <ul className="stagger divide-y divide-line">
          {d.recent.map((p) => (
            <li key={p.id}>
              <Link to={`/bookings/${p.bookingId}`} className="flex items-center gap-3 py-3 text-sm">
                <span className="hidden w-14 shrink-0 text-xs text-muted sm:block">{shortDay(p.paidOn ?? p.createdOn)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.guestName} · {p.bookingCode}</span>
                  <span className="block truncate text-xs text-muted">
                    <span className="sm:hidden">{shortDay(p.paidOn ?? p.createdOn)} · </span>{PAYMENT_KIND_LABEL[p.kind]} · {PAYMENT_METHOD_LABEL[p.method]} · {p.number}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <StatusPill tone={PAYMENT_TONE[p.status]}>{PAYMENT_STATUS_LABEL[p.status]}</StatusPill>
                  <span className="font-semibold tabular">{p.kind === 'refund' ? '-' : ''}{money(p.amount)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
