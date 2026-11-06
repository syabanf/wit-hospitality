import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChartColumnIncreasing, Copy, Equal } from 'lucide-react'
import type { BudgetRow } from '@/application/revenue'
import { BUDGET_FIELDS, budgetRoomRevenue, spreadEvenly, variance, type BudgetMonth, type Variance } from '@/domain/revenue'
import { cn } from '@/lib/cn'
import { shortMonth } from '@/lib/dates'
import { count, money, percent } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { withParams } from '../owner/filters'

const monthName = (r: Pick<BudgetRow, 'month' | 'partial'>) => `${shortMonth(`${r.month}-01`)}${r.partial ? ' (to date)' : ''}`
const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0)

/** A variance as a signed amount and percent, green when it helps profit and red when it hurts. */
function VarianceCell({ v }: { v: Variance }) {
  return (
    <span className={cn('tabular', v.good === true && 'text-success', v.good === false && 'text-danger')}>
      {v.amount > 0 ? '+' : ''}
      {money(v.amount)}
      {v.pct !== null && <span className="ml-1 text-xs">({percent(v.pct, { signed: true, digits: 0 })})</span>}
    </span>
  )
}

/** Budget per villa and month, entered here, beside the actual from stays and posted entries. */
export default function BudgetPage() {
  const { revenue, clock } = useServices()
  const { can } = useAccess()
  const [params, setParams] = useSearchParams()
  const thisYear = Number(clock.today().slice(0, 4))
  const year = Number(params.get('year')) || thisYear
  const villaId = params.get('villa') || undefined
  const options = useResource('revenue.options', () => revenue.options())
  const data = useResource(`revenue.budget:${year}|${villaId ?? ''}`, () => revenue.budget(year, { villaId }))

  if (options.status === 'error' && !options.data) return <ErrorState error={options.error} onRetry={options.reload} />
  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!options.data || !data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const set = (next: Record<string, string | undefined>) => setParams(withParams(params, next), { replace: true })
  const years = [thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: String(y) }))
  const started = d.rows.filter((r) => r.actual)
  const total = (pick: (r: BudgetRow) => number) => sum(started.map(pick))

  return (
    <div className={cn('space-y-4', data.status === 'loading' && 'opacity-60 transition-opacity')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap gap-2">
          <Select aria-label="Year" tone="card" value={String(year)} options={years} onChange={(e) => set({ year: e.target.value })} />
          <Select
            aria-label="Villa"
            tone="card"
            className="min-w-0 basis-56"
            value={villaId ?? ''}
            options={[{ value: '', label: 'All villas' }, ...options.data.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]}
            onChange={(e) => set({ villa: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/reports/rm-budget" className={buttonStyles({ variant: 'card' })}>
            Report
          </Link>
          <Link to="/revenue" className={buttonStyles({ variant: 'card' })}>
            <ChartColumnIncreasing aria-hidden className="size-4" /> Revenue
          </Link>
        </div>
      </div>

      <Card aria-labelledby="bg-actual">
        <CardHeader id="bg-actual" title={`Budget against actual, ${year}`} />
        <DataTable
          label="Budget against actual by month"
          rows={d.rows}
          rowKey={(r) => r.month}
          columns={[
            { key: 'm', header: 'Month', cell: monthName },
            { key: 'n', header: 'Nights', align: 'right', cell: (r) => (r.actual ? `${count(r.actual.roomNights)} / ${count(r.budget.roomNights)}` : count(r.budget.roomNights)) },
            { key: 'b', header: 'Room revenue budget', align: 'right', cell: (r) => money(budgetRoomRevenue(r.budget)) },
            { key: 'a', header: 'Actual', align: 'right', cell: (r) => (r.actual ? money(r.actual.roomRevenue) : <span className="text-muted">–</span>) },
            { key: 'v', header: 'Room revenue variance', align: 'right', cell: (r) => (r.actual ? <VarianceCell v={variance(r.actual.roomRevenue, budgetRoomRevenue(r.budget))} /> : '') },
            { key: 'o', header: 'Other revenue variance', align: 'right', cell: (r) => (r.actual ? <VarianceCell v={variance(r.actual.otherRevenue, r.budget.otherRevenue)} /> : '') },
            { key: 'e', header: 'Expense variance', align: 'right', cell: (r) => (r.actual ? <VarianceCell v={variance(r.actual.expenses, r.budget.expenses, true)} /> : '') },
          ]}
          footer={[
            'To date',
            `${count(total((r) => r.actual?.roomNights ?? 0))} / ${count(total((r) => r.budget.roomNights))}`,
            money(total((r) => budgetRoomRevenue(r.budget))),
            money(total((r) => r.actual?.roomRevenue ?? 0)),
            <VarianceCell key="v" v={variance(total((r) => r.actual?.roomRevenue ?? 0), total((r) => budgetRoomRevenue(r.budget)))} />,
            <VarianceCell key="o" v={variance(total((r) => r.actual?.otherRevenue ?? 0), total((r) => r.budget.otherRevenue))} />,
            <VarianceCell key="e" v={variance(total((r) => r.actual?.expenses ?? 0), total((r) => r.budget.expenses), true)} />,
          ]}
        />
        <p className="mt-3 text-xs text-muted">Nights read actual / budget. Room revenue comes from the stays night by night; other revenue and expenses from posted entries, as in profit and loss by villa. Green helps profit, red hurts it.</p>
      </Card>

      {villaId ? (
        <BudgetEditor key={`${villaId}|${year}|${d.budget?.updatedOn ?? ''}`} villaId={villaId} year={year} initial={d.rows.map((r) => r.budget)} editable={can('finance', 'edit') && can('reports', 'report')} updated={d.budget ? `Saved by ${d.budget.updatedBy} on ${d.budget.updatedOn}` : 'No budget saved for this year yet.'} onSaved={data.reload} />
      ) : (
        <p className="rounded-panel bg-raised px-4 py-6 text-center text-sm text-muted">Pick a villa to enter or change its budget. All villas shows the budgets summed.</p>
      )}
    </div>
  )
}

interface EditorProps {
  villaId: string
  year: number
  initial: readonly BudgetMonth[]
  editable: boolean
  updated: string
  onSaved: () => void
}

/** Twelve months of figures with a year-total row that spreads evenly, and a copy from last year. */
function BudgetEditor({ villaId, year, initial, editable, updated, onSaved }: EditorProps) {
  const { revenue } = useServices()
  const toast = useToast()
  const [months, setMonths] = useState<BudgetMonth[]>(() => initial.map((m) => ({ ...m })))
  const [totals, setTotals] = useState(() => ({ roomNights: sum(initial.map((m) => m.roomNights)), adr: Math.round(sum(initial.map(budgetRoomRevenue)) / Math.max(1, sum(initial.map((m) => m.roomNights)))), otherRevenue: sum(initial.map((m) => m.otherRevenue)), expenses: sum(initial.map((m) => m.expenses)) }))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null)
  const edit = (i: number, key: keyof BudgetMonth, value: number) => setMonths((list) => list.map((m, j) => (j === i ? { ...m, [key]: value } : m)))

  function spread() {
    const nights = spreadEvenly(totals.roomNights)
    const other = spreadEvenly(totals.otherRevenue)
    const costs = spreadEvenly(totals.expenses)
    setMonths(months.map((_, i) => ({ roomNights: nights[i] ?? 0, adr: totals.adr, otherRevenue: other[i] ?? 0, expenses: costs[i] ?? 0 })))
  }

  async function copy() {
    setBusy('copy')
    try {
      const last = await revenue.copyFromLastYear(villaId, year)
      if (last) setMonths(last)
      else toast({ title: 'Nothing to copy', description: `There is no budget and no stays on record for ${year - 1}.`, tone: 'danger' })
    } catch (error) {
      toast({ title: 'Could not copy', description: error instanceof Error ? error.message : undefined, tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }

  async function save() {
    setBusy('save')
    setErrors({})
    try {
      await revenue.saveBudget({ villaId, year, months })
      toast({ title: `Budget ${year} saved` })
      onSaved()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setBusy(null)
    }
  }

  const cell = (i: number, key: keyof BudgetMonth) => (
    <Input
      aria-label={`${BUDGET_FIELDS.find((f) => f.key === key)?.label} ${shortMonth(`${year}-${String(i + 1).padStart(2, '0')}-01`)}`}
      aria-invalid={Boolean(errors[`months.${i}.${key}`])}
      className={cn('ml-auto h-10 tabular', key === 'roomNights' ? 'w-24' : 'w-36')}
      type="number"
      inputMode="numeric"
      min={0}
      disabled={!editable}
      value={months[i]?.[key] ?? 0}
      onChange={(e) => edit(i, key, Number(e.target.value))}
    />
  )
  const firstError = Object.values(errors)[0]

  return (
    <Card aria-labelledby="bg-edit">
      <CardHeader
        id="bg-edit"
        title={`Budget ${year}`}
        action={
          editable && (
            <Button size="sm" variant="soft" loading={busy === 'copy'} onClick={() => void copy()}>
              <Copy aria-hidden className="size-4" /> Copy from {year - 1}
            </Button>
          )
        }
      />
      <p className="-mt-2 mb-3 text-xs text-muted">{updated}</p>
      {editable && (
        <div className="mb-4 flex flex-wrap items-end gap-2 rounded-panel bg-raised p-3">
          {BUDGET_FIELDS.map((f) => (
            <label key={f.key} className="min-w-0 flex-1 basis-32 text-xs text-muted">
              {f.key === 'adr' ? 'ADR every month' : `${f.label}, year total`}
              <Input className="mt-1 h-10 tabular" tone="card" type="number" inputMode="numeric" min={0} value={totals[f.key]} onChange={(e) => setTotals({ ...totals, [f.key]: Number(e.target.value) })} />
            </label>
          ))}
          <Button size="sm" variant="solid" onClick={spread}>
            <Equal aria-hidden className="size-4" /> Spread evenly
          </Button>
        </div>
      )}
      <DataTable
        label={`Budget ${year} by month`}
        rows={months.map((m, i) => ({ m, i }))}
        rowKey={(r) => String(r.i)}
        columns={[
          { key: 'm', header: 'Month', cell: (r) => shortMonth(`${year}-${String(r.i + 1).padStart(2, '0')}-01`) },
          { key: 'n', header: 'Room nights', align: 'right', cell: (r) => cell(r.i, 'roomNights') },
          { key: 'a', header: 'ADR', align: 'right', cell: (r) => cell(r.i, 'adr') },
          { key: 'r', header: 'Room revenue', align: 'right', cell: (r) => money(budgetRoomRevenue(r.m)) },
          { key: 'o', header: 'Other revenue', align: 'right', cell: (r) => cell(r.i, 'otherRevenue') },
          { key: 'e', header: 'Expenses', align: 'right', cell: (r) => cell(r.i, 'expenses') },
        ]}
        footer={['Year', count(sum(months.map((m) => m.roomNights))), '', money(sum(months.map(budgetRoomRevenue))), money(sum(months.map((m) => m.otherRevenue))), money(sum(months.map((m) => m.expenses)))]}
      />
      {firstError && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {firstError}
        </p>
      )}
      {editable && (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="accent" loading={busy === 'save'} onClick={() => void save()}>
            Save budget
          </Button>
          <Button variant="soft" onClick={() => setMonths(initial.map((m) => ({ ...m })))}>
            Undo changes
          </Button>
        </div>
      )}
    </Card>
  )
}
