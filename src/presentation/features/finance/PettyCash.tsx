import { Link } from 'react-router'
import { ArrowDownLeft, ArrowLeftRight } from 'lucide-react'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { StatusPill } from '../../ui/Badge'
import { buttonStyles } from '../../ui/buttonStyles'
import type { PettyRow } from '@/application/views'
import { topUpLink } from './petty'

/** Balance against the float, who holds it, and the two everyday actions: spend with a receipt, top up. */
export function PettyFacts({ row, compact = false }: { row: PettyRow; compact?: boolean }) {
  const float = row.account.floatLimit ?? 0
  const share = float > 0 ? Math.min(1, row.balance / float) : 0
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={compact ? 'text-2xl font-medium tracking-tight tabular' : 'text-[44px] leading-none font-medium tracking-tight tabular'}>{money(row.balance)}</p>
        <StatusPill tone={row.low ? 'accent' : 'success'}>{row.low ? 'Low' : 'OK'}</StatusPill>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-control" role="meter" aria-label="Balance against the float" aria-valuemin={0} aria-valuemax={float} aria-valuenow={row.balance}>
        <div className={`h-full rounded-full animate-grow ${row.low ? 'bg-accent' : 'bg-success'}`} style={{ width: `${share * 100}%` }} />
      </div>
      <p className="text-xs text-muted">
        Float {money(float)} · held by {row.custodian} · spent {money(row.spent30)} in 30 days
        {row.pendingSpend > 0 && ` · ${money(row.pendingSpend)} waiting for approval`}
        {row.lastCount ? ` · counted ${shortDay(row.lastCount.date)}` : ' · never counted'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Link to={`/finance/transactions/new?kind=cash_out&account=${row.account.id}`} className={buttonStyles({ variant: 'solid', size: 'sm' })}>
          <ArrowDownLeft aria-hidden className="size-3.5" /> Spend with receipt
        </Link>
        {row.topUp > 0 && !row.topUpPending && (
          <Link to={topUpLink(row)} className={buttonStyles({ variant: row.low ? 'accent' : 'soft', size: 'sm' })}>
            <ArrowLeftRight aria-hidden className="size-3.5" /> Top up {money(row.topUp)}
          </Link>
        )}
        {row.topUpPending && <span className="self-center text-xs text-muted">A top-up waits for approval</span>}
      </div>
    </div>
  )
}
