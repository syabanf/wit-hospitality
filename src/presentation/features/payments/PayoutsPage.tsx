import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { CircleCheck } from 'lucide-react'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'

type Chip = 'all' | 'waiting' | 'received' | 'not_due'

/** Airbnb pays out the day after arrival; this page matches what was expected with what reached the bank. */
export default function PayoutsPage() {
  const { payments } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('payments.payouts', () => payments.payouts())
  const [params, setParams] = useSearchParams()
  const [busy, setBusy] = useState<string | null>(null)
  const chip = (params.get('state') ?? 'all') as Chip
  const account = params.get('account') ?? ''

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const stateOf = (r: (typeof d.rows)[number]) => (r.outstanding === 0 ? 'received' : r.dueOn > d.today ? 'not_due' : 'waiting')
  const scoped = d.rows.filter((r) => !account || r.booking.airbnbAccountId === account)
  const rows = chip === 'all' ? scoped : scoped.filter((r) => stateOf(r) === chip)
  const set = (k: string, v: string) => {
    const search = new URLSearchParams(params)
    if (v && v !== 'all') search.set(k, v)
    else search.delete(k)
    search.delete('page')
    setParams(search, { replace: true })
  }

  async function receive(r: (typeof d.rows)[number]) {
    setBusy(r.booking.id)
    try {
      await payments.record({ bookingId: r.booking.id, kind: 'payout', method: 'airbnb_payout', amount: r.outstanding, reference: r.booking.airbnbCode ?? '', payer: r.booking.account?.name ?? 'Airbnb', note: 'Payout matched on the bank statement' })
      toast({ title: `Payout received for ${r.booking.code}`, description: 'Booked as a cash-in on the bank for approval' })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not record the payout', description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {d.byAccount.map((a) => (
          <StatTile key={a.account.id} label={a.account.name} value={money(a.received)} hint={`of ${money(a.expected)} expected · ${a.waiting} waiting`} active={account === a.account.id} onClick={() => set('account', account === a.account.id ? '' : a.account.id)} />
        ))}
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={(['all', 'waiting', 'not_due', 'received'] as Chip[]).map((c) => ({ value: c, label: c === 'all' ? 'All' : c === 'not_due' ? 'Not due' : c === 'waiting' ? 'Waiting' : 'Received', count: c === 'all' ? scoped.length : scoped.filter((r) => stateOf(r) === c).length }))}
          chip={chip}
          onChip={(c) => set('state', c)}
          filters={<Select aria-label="Airbnb account" value={account} options={[{ value: '', label: 'Every account' }, ...d.byAccount.map((a) => ({ value: a.account.id, label: a.account.name }))]} onChange={(e) => set('account', e.target.value)} />}
          active={params.size > 0}
          onClear={() => setParams({}, { replace: true })}
        />
        <div className="overflow-x-auto">
          <ListTable
            label="Airbnb payouts"
            rows={rows}
            rowKey={(r) => r.booking.id}
            href={(r) => `/bookings/${r.booking.id}`}
            defaultSort={{ key: 'due', dir: 'desc' }}
            exportName="airbnb-payouts"
            exportDate={d.today}
            empty={<EmptyState title="No payout in this view" />}
            columns={[
              { key: 'guest', header: 'Guest', cell: (r) => r.booking.guestName, value: (r) => r.booking.guestName },
              { key: 'code', header: 'Booking', cell: (r) => <span className="font-mono text-xs">{r.booking.code}</span>, value: (r) => r.booking.code, hide: 'lg' },
              { key: 'acc', header: 'Account', cell: (r) => r.booking.account?.name ?? '', value: (r) => r.booking.account?.name ?? '', hide: 'xl' },
              { key: 'due', header: 'Expected on', cell: (r) => shortDay(r.dueOn), value: (r) => r.dueOn },
              { key: 'exp', header: 'Expected', align: 'right', cell: (r) => <span className="tabular">{money(r.expected)}</span>, value: (r) => r.expected, total: (s) => money(s), hide: 'lg' },
              { key: 'got', header: 'Received', align: 'right', cell: (r) => <span className="font-semibold tabular">{money(r.received)}</span>, value: (r) => r.received, total: (s) => money(s) },
              { key: 'state', header: 'State', cell: (r) => <StatusPill tone={stateOf(r) === 'received' ? 'success' : stateOf(r) === 'waiting' ? 'warning' : 'neutral'}>{stateOf(r) === 'received' ? 'Received' : stateOf(r) === 'waiting' ? 'Waiting' : 'Not due'}</StatusPill>, value: stateOf },
              {
                key: 'act',
                header: '',
                align: 'right',
                cell: (r) =>
                  stateOf(r) === 'waiting' &&
                  can('payments', 'create') && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button size="sm" variant="soft" loading={busy === r.booking.id} onClick={() => void receive(r)}>
                        <CircleCheck aria-hidden className="size-3.5" /> Received
                      </Button>
                    </span>
                  ),
              },
            ]}
            card={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{r.booking.guestName}</p>
                  <p className="truncate text-xs text-muted">
                    {r.booking.code} · {shortDay(r.dueOn)}
                  </p>
                </div>
                <span className="text-sm font-semibold tabular">{money(r.received)}</span>
              </div>
            )}
          />
        </div>
      </Card>
    </div>
  )
}
