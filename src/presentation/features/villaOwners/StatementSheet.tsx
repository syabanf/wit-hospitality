import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ChevronDown } from 'lucide-react'
import type { OwnerServices } from '@/application/owners'
import { CHARGED_LABEL, FEE_BASIS_LABEL, OWNER_STAY_PRICING_LABEL } from '@/domain/owner'
import { periodLabel } from '@/domain/payroll'
import { cn } from '@/lib/cn'
import { csvFileName, toCsv } from '@/lib/csv'
import { fullDay, shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { BrandMark } from '../../ui/BrandMark'
import { Card } from '../../ui/Card'

export type StatementView = Omit<Awaited<ReturnType<OwnerServices['statement']>>, 'banks'>

interface Line {
  label: string
  value: number
  strong?: boolean
  /** Shown as a deduction. */
  minus?: boolean
  detail?: ReactNode
}

function Row({ line }: { line: Line }) {
  const [open, setOpen] = useState(false)
  const amount = <span className="tabular">{line.minus && line.value !== 0 ? `(${money(line.value)})` : money(line.value)}</span>
  return (
    <li className={cn('py-2', line.strong && 'font-semibold')}>
      {line.detail ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full cursor-pointer items-center gap-2 text-left hover:text-fg">
          <ChevronDown aria-hidden className={cn('size-4 shrink-0 text-muted transition-transform print:hidden', open && 'rotate-180')} />
          <span className="min-w-0 flex-1">{line.label}</span>
          {amount}
        </button>
      ) : (
        <div className="flex items-center gap-2 pl-6">
          <span className="min-w-0 flex-1">{line.label}</span>
          {amount}
        </div>
      )}
      {line.detail && <div className={cn('mt-2 pl-6 text-xs font-normal', !open && 'hidden print:block')}>{line.detail}</div>}
    </li>
  )
}

function Lines<T>({ rows, cells, empty }: { rows: readonly T[]; cells: (r: T) => ReactNode[]; empty: string }) {
  if (!rows.length) return <p className="text-muted">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-line">
          {rows.map((r, i) => (
            <tr key={i}>
              {cells(r).map((c, j, all) => (
                <td key={j} className={cn('py-1.5 pr-3 align-top', j === all.length - 1 && 'pr-0 text-right whitespace-nowrap tabular')}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The owner statement as a printable sheet. Every figure opens to the stays and entries behind it;
 * printing opens them all. `operator` links each line to its booking and cash entry.
 */
export function StatementSheet({ view, operator = false, actions }: { view: StatementView; operator?: boolean; actions?: ReactNode }) {
  const { contract, owner, villa, location, figures: f, settlement: carry, stays, entries } = view
  if (!f || !carry) return null
  const st = view.statement
  const stayCells = (s: (typeof stays)[number]) => [...(operator ? [<Link key="code" to={`/bookings/${s.bookingId}`} className="font-medium hover:underline">{s.code}</Link>] : []), s.unitCode, `${shortDay(s.checkIn)} to ${shortDay(s.checkOut)}`, s.source, `${s.nights} nights`, money(s.revenue)]
  const entryCells = (e: (typeof entries)[number]) => [shortDay(e.date), operator ? <Link key="number" to={`/finance/transactions/${e.transactionId}`} className="font-medium hover:underline">{e.number}</Link> : e.number, e.category, e.description, money(e.amount)]
  const expenseRows = entries.filter((e) => e.role === 'expense')
  const chargedRows = contract.charged === 'maintenance' ? expenseRows.filter((e) => e.charged) : expenseRows
  const lines: Line[] = [
    { label: 'Room revenue', value: f.roomRevenue, detail: <Lines rows={stays.filter((s) => s.revenue > 0)} cells={stayCells} empty="No nights sold in the month." /> },
    { label: 'Other revenue', value: f.otherRevenue, detail: <Lines rows={entries.filter((e) => e.role === 'other')} cells={entryCells} empty="No other income posted." /> },
    { label: 'Total revenue', value: f.totalRevenue, strong: true },
    { label: 'Airbnb fees', value: f.airbnbFees, minus: true, detail: <Lines rows={stays.filter((s) => s.fee > 0)} cells={(s) => [...stayCells(s).slice(0, -2), money(s.fee)]} empty="No Airbnb arrivals in the month." /> },
    contract.charged === 'maintenance'
      ? { label: `Maintenance from ${money(contract.maintenanceThreshold)}`, value: f.maintenanceCharged, minus: true, detail: <Lines rows={chargedRows} cells={entryCells} empty="No maintenance over the threshold." /> }
      : { label: 'Operating expenses', value: f.expenses, minus: true, detail: <Lines rows={chargedRows} cells={entryCells} empty="No expenses posted." /> },
    ...(contract.charged === 'all' ? [{ label: 'Payroll allocation', value: f.payroll, minus: true }] : []),
    { label: 'Gross operating profit', value: f.gop, strong: true },
    { label: `Management fee, ${contract.feePct}% of ${FEE_BASIS_LABEL[contract.feeBasis].toLowerCase()}${contract.fixedMonthlyFee ? ` plus ${money(contract.fixedMonthlyFee)} a month` : ''}`, value: f.managementFee, minus: true },
    { label: `FF&E reserve, ${contract.reservePct}% of revenue`, value: f.reserve, minus: true },
    { label: `Owner stays, ${f.ownerNights} nights (${OWNER_STAY_PRICING_LABEL[contract.ownerStayPricing].toLowerCase()})`, value: f.ownerStayCharge, minus: true },
    { label: carry.broughtFrom ? 'This month’s net' : 'Net payable to the owner', value: f.netPayable, strong: true },
    ...(carry.broughtFrom ? [{ label: `Brought forward from ${periodLabel(carry.broughtFrom)}`, value: carry.broughtForward, minus: true }, { label: 'Net payable after carry forward', value: carry.payable, strong: true }] : []),
  ]
  const short = carry.payable < 0 ? ((st?.shortfall ?? contract.shortfall) === 'topup' ? 'The owner tops this up' : 'Carries forward to the next statement') : null

  function exportCsv() {
    const rows = [...lines.map((l) => ['Statement', l.label, l.minus ? -l.value : l.value]), ...stays.map((s) => ['Stay', `${s.unitCode} ${s.checkIn} to ${s.checkOut} ${s.source}`, s.revenue]), ...entries.map((e) => ['Entry', `${e.number} ${e.category}: ${e.description}`, e.role === 'other' ? e.amount : -e.amount])]
    const url = URL.createObjectURL(new Blob([toCsv(['Section', 'Line', 'Amount'], rows)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = csvFileName(`owner-statement-${villa.name}-${view.month}`, view.today)
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card as="article" aria-label="Owner statement" className="mx-auto max-w-4xl space-y-6 print:max-w-none print:border-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wider text-muted uppercase">{st ? `Owner statement ${st.number}` : 'Owner statement, not closed'}</p>
          <p className="mt-1 text-2xl font-bold tracking-tight">
            {villa.name}
            <span className="text-accent">.</span>
          </p>
          <p className="mt-1 text-sm text-muted">
            {periodLabel(view.month)} · {location.name} · contract {contract.number}
          </p>
        </div>
        <div className="flex items-center gap-2 text-right text-xs text-muted">
          <span>
            Bali Villa Management
            <br />
            {st ? `Closed ${fullDay(st.closedOn)}` : `Figures as of ${fullDay(view.today)}`}
          </span>
          <BrandMark className="size-8 text-fg" />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 print:grid-cols-3">
        <div className="min-w-0 rounded-panel bg-raised p-4">
          <p className="text-xs text-muted">{carry.broughtFrom ? 'Payable after carry forward' : 'Net payable'}</p>
          <p className="mt-1 text-xl font-medium tracking-tight tabular">{money(carry.payable)}</p>
          <p className="mt-1 text-xs text-muted">{short ?? `Due ${fullDay(view.dueOn)}`}</p>
        </div>
        <div className="min-w-0 rounded-panel bg-raised p-4">
          <p className="text-xs text-muted">Owner</p>
          <p className="mt-1 truncate font-medium">{owner.name}</p>
          <p className="mt-1 truncate text-xs text-muted">
            {owner.bank.bank} {owner.bank.accountNumber}
            {owner.npwp && ` · NPWP ${owner.npwp}`}
          </p>
        </div>
        <div className="min-w-0 rounded-panel bg-raised p-4">
          <p className="text-xs text-muted">Costs charged</p>
          <p className="mt-1 font-medium">{CHARGED_LABEL[contract.charged]}</p>
          <p className="mt-1 text-xs text-muted">{st?.approvedBy ? `Approved by ${st.approvedBy}` : st ? 'Awaiting approval' : 'Open'}</p>
        </div>
      </div>

      <ul className="divide-y divide-line text-sm">
        {lines.map((l) => (
          <Row key={l.label} line={l} />
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 print:hidden">
        <button type="button" onClick={exportCsv} className="cursor-pointer text-sm font-medium hover:underline">
          Download CSV
        </button>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      <p className="text-xs text-muted">Room revenue is earned night by night inside the month and expenses are posted entries mapped to the villa, the same figures as the owner reports. The operator collects and pays on the owner’s behalf; the FF&E reserve is held for the villa. A month below zero is deducted from the next statements until they cover it, unless the contract has the owner top it up.</p>
    </Card>
  )
}
