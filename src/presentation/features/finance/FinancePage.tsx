import { useState } from 'react'
import { Link } from 'react-router'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Plus } from 'lucide-react'
import { change } from '@/domain/dashboard'
import { shortDay } from '@/lib/dates'
import { money, moneyCompact } from '@/lib/format'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TransactionRows } from '../shared/TransactionRows'
import { AccountForm } from './AccountForm'
import { AccountTable } from './AccountTable'
import { ViewToggle } from '../../ui/ViewToggle'
import { useToast } from '../../ui/useToast'

/** The cashboxes and the bank: balances, the last 30 days, and what waits for approval. */
export default function FinancePage() {
  const { finance, clock } = useServices()
  const toast = useToast()
  const data = useResource('finance.overview', () => finance.overview())
  const [opening, setOpening] = useState(false)
  const [layout, setLayout] = useLayout()

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Each location keeps a cashbox; Airbnb payouts and salaries move through the bank. Only posted entries change a balance.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} />
          <Button variant="card" aria-pressed={opening} onClick={() => setOpening((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Account
          </Button>
          <Link to="/finance/transactions/new?kind=cash_out" className={buttonStyles({ variant: 'card' })}>
            <ArrowUpRight aria-hidden className="size-4" /> Cash out
          </Link>
          <Link to="/finance/transactions/new?kind=cash_in" className={buttonStyles({ variant: 'accent' })}>
            <ArrowDownLeft aria-hidden className="size-4" /> Cash in
          </Link>
        </div>
      </div>
      {opening && (
        <AccountForm
          locations={d.locations}
          today={clock.today()}
          save={(input) => finance.createAccount(input)}
          onDone={() => {
            toast({ title: 'Opened the account' })
            setOpening(false)
            data.reload()
          }}
          onCancel={() => setOpening(false)}
        />
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="All balances" value={money(d.total)} hint={`${d.accounts.length} accounts`} to="/finance" />
        <StatTile label="Cash in, 30 days" value={money(d.summary.cashIn)} change={change(d.summary.cashIn, d.previous.cashIn)} to="/finance/cash-in" />
        <StatTile label="Cash out, 30 days" value={money(d.summary.cashOut)} change={change(d.summary.cashOut, d.previous.cashOut)} goodWhenUp={false} to="/finance/cash-out" />
        <StatTile label="Awaiting approval" value={d.pending.length} hint={`${d.drafts} drafts not yet submitted`} to="/finance/approvals" />
      </div>

      {layout === 'table' ? (
        <Card className="p-0" aria-labelledby="accounts-table">
          <div className="p-5 pb-0">
            <CardHeader id="accounts-table" title="Accounts" />
          </div>
          <AccountTable label="Accounts" rows={d.accounts} />
        </Card>
      ) : (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {d.accounts.map((row) => (
          <Link key={row.account.id} to={`/finance/accounts/${row.account.id}`} className="min-w-0 rounded-card border border-line bg-card p-5 shadow-card transition-colors hover:bg-raised">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold tracking-tight">{row.account.name}</p>
                <p className="text-xs text-muted">{row.location?.name ?? 'All locations'}</p>
              </div>
              <Tag tone={row.account.kind === 'bank' ? 'info' : 'neutral'}>{row.account.kind === 'bank' ? 'Bank' : 'Cashbox'}</Tag>
            </div>
            <p className="mt-5 min-w-0 text-2xl leading-tight font-medium tracking-tight break-words tabular xl:text-[28px]">{money(row.balance)}</p>
            <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-panel bg-raised p-2.5">
                <dt className="text-muted">In, 30 days</dt>
                <dd className="mt-0.5 font-medium tabular">{moneyCompact(row.in30.cashIn)}</dd>
              </div>
              <div className="rounded-panel bg-raised p-2.5">
                <dt className="text-muted">Out, 30 days</dt>
                <dd className="mt-0.5 font-medium tabular">{moneyCompact(row.in30.cashOut)}</dd>
              </div>
            </dl>
            <p className="mt-3 truncate text-xs text-muted">{row.lastMovement ? `Last: ${row.lastMovement.description}, ${shortDay(row.lastMovement.date)}` : 'No posted entries yet'}</p>
          </Link>
        ))}
      </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card aria-labelledby="pending-title">
          <CardHeader
            id="pending-title"
            title="Awaiting approval"
            action={
              <Link to="/finance/approvals" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                All <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          />
          <TransactionRows rows={d.pending} empty="Nothing waits for approval." />
        </Card>
        <Card aria-labelledby="recent-title">
          <CardHeader
            id="recent-title"
            title="Latest entries"
            action={
              <Link to="/finance/transactions" className="flex items-center gap-1 text-sm text-accent-text hover:underline">
                All <ArrowRight aria-hidden className="size-4" />
              </Link>
            }
          />
          <TransactionRows rows={d.recent} empty="No entries yet." />
        </Card>
      </div>
    </div>
  )
}

