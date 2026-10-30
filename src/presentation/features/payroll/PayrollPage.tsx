import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Plus, Settings2 } from 'lucide-react'
import { PAYROLL_STATUS_LABEL, PAYROLL_STATUSES, periodLabel, type PayrollStatus } from '@/domain/payroll'
import { money, moneyCompact } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { Select } from '../../ui/Field'
import { FactGrid } from '../../ui/Headline'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { PAYROLL_TONE } from '../shared/tones'
import { useFilters } from '../hr/useFilters'

type StatusFilter = PayrollStatus | 'all'
const CHIPS: StatusFilter[] = ['all', ...PAYROLL_STATUSES]

/** Monthly payroll runs: open the next month, calculate, approve, close and publish. */
export default function PayrollPage() {
  const { payroll, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const navigate = useNavigate()
  const data = useResource('payroll.overview', () => payroll.overview())
  const [opening, setOpening] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const { values, set, clear, active } = useFilters(['status', 'year'] as const)
  const status = (CHIPS.find((c) => c === values.status) ?? 'all') as StatusFilter

  async function openNext() {
    if (!data.data) return
    setOpening(true)
    try {
      const p = await payroll.createPeriod(data.data.nextMonth)
      toast({ title: `Opened payroll ${periodLabel(p.month)}`, description: `${p.lines.length} employees on the run` })
      navigate(`/payroll/${p.id}`)
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not open the period', description: error instanceof Error ? error.message : undefined })
    } finally {
      setOpening(false)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const latest = d.latest
  const open = d.periods.filter((p) => p.period.status !== 'closed')
  const years = [...new Set(d.periods.map((p) => p.period.month.slice(0, 4)))].sort().reverse()
  const rows = d.periods.filter((p) => (status === 'all' || p.period.status === status) && (!values.year || p.period.month.startsWith(values.year)))
  const series = [...rows].sort((a, b) => a.period.month.localeCompare(b.period.month))
  const picked = series.find((p) => p.period.id === selected) ?? series.at(-1) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">One run per month: calculate from salaries, attendance, overtime and loans, approve, close against the bank, publish the payslips.</p>
        <div className="flex flex-wrap gap-2">
          <Link to="/payroll/settings" className={buttonStyles({ variant: 'card' })}>
            <Settings2 aria-hidden className="size-4" /> Settings
          </Link>
          {can('payroll', 'create') && (
            <Button variant="accent" loading={opening} onClick={() => void openNext()}>
              {!opening && <Plus aria-hidden className="size-4" />} Open {periodLabel(d.nextMonth)}
            </Button>
          )}
        </div>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Headcount" value={d.headcount} hint="Active employees" to="/hr/employees" />
        <StatTile label={latest ? `Net pay, ${latest.label}` : 'Net pay'} value={money(latest?.totals.net ?? 0)} hint={latest ? PAYROLL_STATUS_LABEL[latest.period.status] : 'No run yet'} to={latest ? `/payroll/${latest.period.id}` : '/payroll'} />
        <StatTile label="Company cost" value={money(latest?.totals.cost ?? 0)} hint="Net plus company BPJS" to={latest ? `/payroll/${latest.period.id}` : '/payroll'} />
        <StatTile label="Open runs" value={open.length} hint={open.map((p) => p.label).join(', ') || 'Everything closed'} to="/payroll" />
      </div>
      {series.length > 0 && (
        <div className="stagger grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <Card aria-labelledby="pay-series">
            <CardHeader id="pay-series" title="Net pay per period" action={<p className="text-xs text-muted">Click a column for its totals</p>} />
            <ColumnChart
              label="Net pay per period"
              className="h-56 lg:h-64"
              data={series.map((p) => ({ key: p.period.id, label: p.label.split(' ')[0]?.slice(0, 3) ?? p.period.month, value: p.totals.net }))}
              selected={picked?.period.id ?? null}
              onSelect={setSelected}
              format={money}
              tick={moneyCompact}
              badge={(datum, i) => {
                const prev = series[i - 1]
                if (!prev || prev.totals.net === 0) return 'First run'
                const change = (datum.value - prev.totals.net) / prev.totals.net
                return `${change >= 0 ? '+' : '-'}${Math.abs(Math.round(change * 100))}%`
              }}
            />
          </Card>
          {picked && (
            <Card aria-labelledby="pay-picked" className="animate-pop-in" key={picked.period.id}>
              <CardHeader id="pay-picked" title={picked.label} action={<StatusPill tone={PAYROLL_TONE[picked.period.status]}>{PAYROLL_STATUS_LABEL[picked.period.status]}</StatusPill>} />
              <p className="text-xs text-muted">Net pay</p>
              <p className="min-w-0 text-[32px] leading-none font-medium tracking-tight break-words tabular">{money(picked.totals.net)}</p>
              <FactGrid className="mt-4 grid-cols-2" facts={[['Employees', picked.totals.employees], ['Gross', money(picked.totals.gross)], ['Deductions', money(picked.totals.deductions)], ['Company cost', money(picked.totals.cost)]]} />
              <Link to={`/payroll/${picked.period.id}`} className={buttonStyles({ variant: 'solid', size: 'sm', className: 'mt-4' })}>
                Open the run
              </Link>
            </Card>
          )}
        </div>
      )}
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : PAYROLL_STATUS_LABEL[c], count: c === 'all' ? d.periods.length : d.periods.filter((p) => p.period.status === c).length }))}
          chip={status}
          onChip={(c) => set({ status: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.periods.length} runs`}
          filters={<Select aria-label="Year" value={values.year} options={[{ value: '', label: 'Every year' }, ...years.map((y) => ({ value: y, label: y }))]} onChange={(e) => set({ year: e.target.value })} />}
          active={active}
          onClear={clear}
        />
        <ListTable
          label="Payroll periods"
          rows={rows}
          rowKey={(p) => p.period.id}
          href={(p) => `/payroll/${p.period.id}`}
          exportName="payroll-periods"
          exportDate={clock.today()}
          empty={<EmptyState title={d.periods.length ? 'No run matches' : 'No payroll yet'}>{d.periods.length ? 'Nothing fits these filters.' : 'Open the first month to start.'}</EmptyState>}
          columns={[
            { key: 'month', header: 'Period', cell: (p) => <span className={p.period.id === picked?.period.id ? 'text-accent-text' : undefined}>{p.label}</span>, value: (p) => p.period.month },
            { key: 'status', header: 'Status', cell: (p) => <StatusPill tone={PAYROLL_TONE[p.period.status]}>{PAYROLL_STATUS_LABEL[p.period.status]}</StatusPill>, value: (p) => PAYROLL_STATUS_LABEL[p.period.status] },
            { key: 'emp', header: 'Employees', align: 'right', cell: (p) => <span className="tabular">{p.totals.employees}</span>, value: (p) => p.totals.employees, hide: 'lg' },
            { key: 'gross', header: 'Gross', align: 'right', cell: (p) => <span className="tabular">{money(p.totals.gross)}</span>, value: (p) => p.totals.gross, hide: 'lg', total: (sum) => money(sum) },
            { key: 'ded', header: 'Deductions', align: 'right', cell: (p) => <span className="tabular">{money(p.totals.deductions)}</span>, value: (p) => p.totals.deductions, hide: 'xl', total: (sum) => money(sum) },
            { key: 'net', header: 'Net pay', align: 'right', cell: (p) => <span className="font-semibold tabular">{money(p.totals.net)}</span>, value: (p) => p.totals.net, total: (sum) => money(sum) },
            { key: 'cost', header: 'Company cost', align: 'right', cell: (p) => <span className="tabular">{money(p.totals.cost)}</span>, value: (p) => p.totals.cost, hide: 'xl', total: (sum) => money(sum) },
            { key: 'slips', header: 'Payslips', cell: (p) => (p.period.published ? 'Published' : 'Not published'), value: (p) => (p.period.published ? 1 : 0), hide: 'xl' },
          ]}
          card={(p) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{p.label}</p>
                <p className="text-xs text-muted">
                  {p.totals.employees} employees · net {money(p.totals.net)}
                </p>
              </div>
              <StatusPill tone={PAYROLL_TONE[p.period.status]}>{PAYROLL_STATUS_LABEL[p.period.status]}</StatusPill>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
