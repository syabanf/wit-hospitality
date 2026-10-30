import { useSearchParams } from 'react-router'
import { Download, Printer } from 'lucide-react'
import { operatingMargin, totalRevenue } from '@/domain/performance'
import { cn } from '@/lib/cn'
import { csvFileName, toCsv } from '@/lib/csv'
import { addMonths, fullDay, longMonth, startOfMonth } from '@/lib/dates'
import { money, percent } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { BrandMark } from '../../ui/BrandMark'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { rangeLabel, withParams } from './filters'

const monthName = (m: string) => `${longMonth(`${m}-01`)} ${m.slice(0, 4)}`

interface Line {
  label: string
  now: number
  before?: number
  strong?: boolean
  indent?: boolean
}

function Section({ title, lines }: { title: string; lines: readonly Line[] }) {
  return (
    <section className="break-inside-avoid">
      <h2 className="mb-1 text-xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      <table className="w-full table-fixed text-sm" aria-label={title}>
        <tbody className="divide-y divide-line">
          {lines.map((l) => (
            <tr key={l.label} className={cn(l.strong && 'font-semibold')}>
              <td className={cn('py-2 pr-3', l.indent && 'pl-4 text-body')}>{l.label}</td>
              <td className="w-36 py-2 pl-3 text-right whitespace-nowrap tabular sm:w-44">{money(l.now)}</td>
              <td className="hidden w-44 py-2 pl-3 text-right whitespace-nowrap text-muted tabular sm:table-cell print:table-cell">{l.before === undefined ? '' : money(l.before)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

/** A printable monthly owner statement for the portfolio or one villa. */
export default function OwnerStatementPage() {
  const { performance, clock } = useServices()
  const [params, setParams] = useSearchParams()
  const today = clock.today()
  const months = Array.from({ length: 12 }, (_, i) => addMonths(startOfMonth(today), -i).slice(0, 7))
  const month = months.find((m) => m === params.get('month')) ?? months[0] ?? today.slice(0, 7)
  const villaId = params.get('villa') || undefined
  const data = useResource(`owner.statement:${month}:${villaId ?? ''}`, () => performance.statement(month, villaId))
  const set = (next: Record<string, string | undefined>) => setParams(withParams(params, next), { replace: true })

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={10} />
  const d = data.data
  const scopeName = d.villa ? d.villa.name : 'Whole portfolio'
  const lastMonth = d.previous.from.slice(0, 7)

  const revenue: Line[] = [
    ...d.sources.map((s) => ({ label: `Room revenue, ${s.label}`, now: s.revenue, indent: true })),
    { label: 'Room revenue', now: d.pnl.revenue, before: d.previousPnl.revenue },
    ...d.otherIncome.map((o) => ({ label: o.label, now: o.amount, indent: true })),
    { label: 'Other income', now: d.pnl.other, before: d.previousPnl.other },
    { label: 'Total revenue', now: totalRevenue(d.pnl), before: totalRevenue(d.previousPnl), strong: true },
  ]
  const deductions: Line[] = [
    { label: 'Airbnb fees', now: d.pnl.fees, before: d.previousPnl.fees },
    ...d.costs.map((c) => ({ label: c.label, now: c.amount, before: c.before, indent: true })),
    { label: 'Operating expenses', now: d.pnl.expenses, before: d.previousPnl.expenses },
    { label: 'Payroll allocation', now: d.pnl.payroll, before: d.previousPnl.payroll },
    { label: 'Total deductions', now: d.pnl.fees + d.pnl.expenses + d.pnl.payroll, before: d.previousPnl.fees + d.previousPnl.expenses + d.previousPnl.payroll, strong: true },
  ]
  const kpis = [
    ['Occupancy', percent(d.rooms.now.occupancy, { digits: 0 }), percent(d.rooms.before.occupancy, { digits: 0 })],
    ['ADR', money(d.rooms.now.adr), money(d.rooms.before.adr)],
    ['RevPAR', money(d.rooms.now.revpar), money(d.rooms.before.revpar)],
    ['Operating margin', percent(operatingMargin(d.pnl), { digits: 0 }), percent(operatingMargin(d.previousPnl), { digits: 0 })],
  ] as const

  function exportCsv() {
    const rows = [
      ...revenue.map((l) => ['Revenue', l.label, l.now, l.before ?? '']),
      ...deductions.map((l) => ['Deductions', l.label, l.now, l.before ?? '']),
      ['Result', 'Net income', d.pnl.profit, d.previousPnl.profit],
      ['Memo', 'Maintenance jobs in the month', d.maintenance, ''],
      ...kpis.map(([label, now, before]) => ['Rooms', label, now, before]),
      ...d.cash.accounts.map((a) => ['Cash', a.account.name, a.balance, '']),
    ]
    const url = URL.createObjectURL(new Blob([toCsv(['Section', 'Line', monthName(month), monthName(lastMonth)], rows)], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = csvFileName(`owner-statement-${scopeName}-${month}`, today)
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <div className="flex min-w-0 flex-wrap gap-2">
          <Select aria-label="Month" tone="card" value={month} options={months.map((m) => ({ value: m, label: monthName(m) }))} onChange={(e) => set({ month: e.target.value })} />
          <Select aria-label="Villa" tone="card" value={villaId ?? ''} options={[{ value: '', label: 'Whole portfolio' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => set({ villa: e.target.value || undefined })} />
        </div>
        <div className="flex gap-2">
          <Button variant="card" onClick={exportCsv}>
            <Download aria-hidden className="size-4" /> Export CSV
          </Button>
          <Button variant="accent" onClick={() => window.print()}>
            <Printer aria-hidden className="size-4" /> Print or save as PDF
          </Button>
        </div>
      </div>

      <Card as="article" aria-label="Owner statement" className={cn('mx-auto max-w-4xl animate-rise space-y-6 print:max-w-none print:border-0 print:shadow-none', data.status === 'loading' && 'opacity-60')}>
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-line pb-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wider text-muted uppercase">Owner statement</p>
            <p className="mt-1 text-2xl font-bold tracking-tight">
              {scopeName}
              <span className="text-accent">.</span>
            </p>
            <p className="mt-1 text-sm text-muted">
              {monthName(month)}, {rangeLabel(d.range.from, d.range.to)}
              {d.location && ` · ${d.location.name}`}
            </p>
          </div>
          <div className="flex items-center gap-2 text-right text-xs text-muted">
            <span>
              Bali Villa Management
              <br />
              Issued {fullDay(today)}
            </span>
            <BrandMark className="size-8 text-fg" />
          </div>
        </header>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 print:grid-cols-3">
          <div className="min-w-0 rounded-panel bg-raised p-4">
            <p className="text-xs text-muted">Net income</p>
            <p className="mt-1 text-xl font-medium tracking-tight tabular xl:text-2xl">{money(d.pnl.profit)}</p>
            <p className="mt-1 text-xs text-muted">{monthName(lastMonth)}: {money(d.previousPnl.profit)}</p>
          </div>
          <div className="min-w-0 rounded-panel bg-raised p-4">
            <p className="text-xs text-muted">Total revenue</p>
            <p className="mt-1 text-xl font-medium tracking-tight tabular xl:text-2xl">{money(totalRevenue(d.pnl))}</p>
            <p className="mt-1 text-xs text-muted">{monthName(lastMonth)}: {money(totalRevenue(d.previousPnl))}</p>
          </div>
          <div className="min-w-0 rounded-panel bg-raised p-4">
            <p className="text-xs text-muted">Cash in the accounts</p>
            <p className="mt-1 text-xl font-medium tracking-tight tabular xl:text-2xl">{money(d.cash.total)}</p>
            <p className="mt-1 text-xs text-muted">Posted entries, {fullDay(today)}</p>
          </div>
        </div>

        <div className="flex justify-end text-xs font-semibold tracking-wider text-muted uppercase">
          <span className="w-36 text-right sm:w-44">{monthName(month)}</span>
          <span className="hidden w-44 text-right sm:inline print:inline">{monthName(lastMonth)}</span>
        </div>
        <Section title="Revenue" lines={revenue} />
        <Section title="Deductions" lines={deductions} />
        <Section title="Result" lines={[{ label: 'Net income', now: d.pnl.profit, before: d.previousPnl.profit, strong: true }]} />

        <section className="break-inside-avoid">
          <h2 className="mb-1 text-xs font-semibold tracking-wider text-muted uppercase">Rooms</h2>
          <table className="w-full table-fixed text-sm" aria-label="Rooms">
            <tbody className="divide-y divide-line">
              {kpis.map(([label, now, before]) => (
                <tr key={label}>
                  <td className="py-2 pr-3">{label}</td>
                  <td className="w-36 py-2 pl-3 text-right tabular sm:w-44">{now}</td>
                  <td className="hidden w-44 py-2 pl-3 text-right text-muted tabular sm:table-cell print:table-cell">{before}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="break-inside-avoid">
          <h2 className="mb-1 text-xs font-semibold tracking-wider text-muted uppercase">Cash position</h2>
          <table className="w-full table-fixed text-sm" aria-label="Cash position">
            <tbody className="divide-y divide-line">
              {d.cash.accounts.map((a) => (
                <tr key={a.account.id}>
                  <td className="truncate py-2 pr-3">{a.account.name}</td>
                  <td className="w-36 py-2 pl-3 text-right whitespace-nowrap tabular sm:w-44">{money(a.balance)}</td>
                  <td className="hidden w-44 sm:table-cell print:table-cell" />
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <p className="border-t border-line pt-4 text-xs text-muted">
          Room revenue is earned night by night inside the month. Expenses are posted entries mapped to the villa; payroll is the closed payroll allocated by employee. Maintenance jobs in the month cost {money(d.maintenance)}, already inside operating expenses once recorded.
        </p>
      </Card>
    </div>
  )
}
