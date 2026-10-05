import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ArrowDownLeft, Pencil } from 'lucide-react'
import { cashSummary, TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { addDays } from '@/lib/dates'
import { cn } from '@/lib/cn'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Gate } from '../../ui/Gate'
import { FactGrid, Headline } from '../../ui/Headline'
import { ListTable } from '../../ui/ListTable'
import { PageBar } from '../../ui/PageBar'
import { EmptyState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { withinRange } from '@/lib/dates'
import { useToast } from '../../ui/useToast'
import { TRANSACTION_TONE } from '../shared/tones'
import { AccountForm } from './AccountForm'

export default function CashAccountPage() {
  const { id = '' } = useParams()
  const { finance, clock } = useServices()
  const toast = useToast()
  const resource = useResource(`finance.account:${id}`, () => finance.account(id), { keepPrevious: false })
  const [editing, setEditing] = useState(false)
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? undefined
  const to = params.get('to') ?? undefined
  function setRange(r: { from?: string; to?: string }) {
    const search = new URLSearchParams(params)
    if (r.from) search.set('from', r.from)
    else search.delete('from')
    if (r.to) search.set('to', r.to)
    else search.delete('to')
    search.delete('page')
    setParams(search, { replace: true })
  }

  return (
    <Gate resource={resource} what="account" back={{ to: '/finance', label: 'Back to the cashbox' }}>
      {(d) => (
        <>
          <PageBar
            fallback="/finance"
            label="Cashbox"
            actions={
              <>
                <Button variant="card" aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
                  <Pencil aria-hidden className="size-4" /> Edit account
                </Button>
                <Link to={`/finance/transactions/new?account=${d.account.id}`} className={buttonStyles({ variant: 'accent' })}>
                  <ArrowDownLeft aria-hidden className="size-4" /> New entry
                </Link>
              </>
            }
          />
          <div className="space-y-4">
            {editing && (
              <AccountForm
                initial={d.account}
                locations={d.locations}
                today={clock.today()}
                save={(input) => finance.updateAccount(d.account.id, input)}
                onDone={() => {
                  toast({ title: `Saved ${d.account.name}` })
                  setEditing(false)
                  resource.reload()
                }}
                onCancel={() => setEditing(false)}
              />
            )}
            <Card aria-label={d.account.name}>
              <Headline>{d.account.name}</Headline>
              <p className="mt-1 text-sm text-muted">
                {d.account.kind === 'bank' ? 'Bank account' : 'Cashbox'} · {d.location?.name ?? 'All locations'}
              </p>
              <p className="mt-6 text-[44px] leading-none font-medium tracking-tight tabular">{money(d.balance)}</p>
              <FactGrid className="mt-6 grid-cols-2 sm:grid-cols-3" facts={[['Opening balance', money(d.account.openingBalance)], ['Opened on', shortDay(d.account.openedOn)], ['Entries', d.ledger.length]]} />
            </Card>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile label="Balance" value={money(d.balance)} hint={`Opened with ${money(d.account.openingBalance)}`} to={`/finance/transactions?account=${d.account.id}`} />
              <StatTile label="In, 30 days" value={money(cashSummary(d.ledger, addDays(clock.today(), -29), addDays(clock.today(), 1)).cashIn)} to={`/finance/transactions?account=${d.account.id}&kind=cash_in`} />
              <StatTile label="Out, 30 days" value={money(cashSummary(d.ledger, addDays(clock.today(), -29), addDays(clock.today(), 1)).cashOut)} to={`/finance/transactions?account=${d.account.id}&kind=cash_out`} />
              <StatTile label="Awaiting approval" value={d.ledger.filter((t) => t.status === 'submitted' || t.status === 'approved').length} hint="Not yet in the balance" to={`/finance/transactions?account=${d.account.id}&status=submitted`} />
            </div>
            <Card className="p-0" aria-labelledby="ledger-title">
              <div className="p-5 pb-0">
                <CardHeader id="ledger-title" title="Ledger" action={<DateRangeFilter today={clock.today()} label="Date" value={{ from, to }} onChange={setRange} />} />
                <p className="mb-2 text-xs text-muted">Running balance counts posted entries only.</p>
              </div>
              <ListTable
                label="Ledger"
                rows={d.ledger.filter((t) => withinRange(t.date, from, to))}
                rowKey={(t) => t.id}
                href={(t) => `/finance/transactions/${t.id}`}
                exportName={`ledger-${d.account.id}`}
                exportDate={clock.today()}
                empty={<EmptyState title="No entries yet" />}
                columns={[
                  { key: 'date', header: 'Date', cell: (t) => shortDay(t.date), value: (t) => t.date },
                  { key: 'no', header: 'Number', cell: (t) => <span className="font-mono text-xs text-muted">{t.number}</span>, value: (t) => t.number, hide: 'lg' },
                  { key: 'desc', header: 'Description', cell: (t) => <span className="line-clamp-1">{t.description}</span>, value: (t) => t.description },
                  { key: 'cat', header: 'Category', cell: (t) => t.categoryName, value: (t) => t.categoryName, hide: 'lg' },
                  { key: 'status', header: 'Status', cell: (t) => <StatusPill tone={TRANSACTION_TONE[t.status]}>{TRANSACTION_STATUS_LABEL[t.status]}</StatusPill>, value: (t) => TRANSACTION_STATUS_LABEL[t.status] },
                  { key: 'amount', header: 'Amount', align: 'right', cell: (t) => <span className={cn('font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>{t.kind === 'cash_out' ? '-' : '+'}{money(t.amount)}</span>, value: (t) => (t.kind === 'cash_out' ? -t.amount : t.amount), total: (sum) => `${sum < 0 ? '-' : '+'}${money(Math.abs(sum))}` },
                  { key: 'run', header: 'Balance', align: 'right', cell: (t) => <span className="tabular">{money(t.running)}</span>, value: (t) => t.running, hide: 'lg' },
                ]}
                card={(t) => (
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{t.description}</p>
                      <p className="text-xs text-muted">
                        {shortDay(t.date)} · {t.categoryName}
                      </p>
                    </div>
                    <span className={cn('text-sm font-semibold tabular', t.kind === 'cash_out' && 'text-muted')}>{t.kind === 'cash_out' ? '-' : '+'}{money(t.amount)}</span>
                  </div>
                )}
              />
            </Card>
          </div>
        </>
      )}
    </Gate>
  )
}
