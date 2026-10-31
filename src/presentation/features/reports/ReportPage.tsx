import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { Search } from 'lucide-react'
import { reportBySlug, type ReportControl, type ReportFilter } from '@/application/reports'
import type { ReportColumn, ReportRow } from '@/application/views'
import { BOOKING_STATUS_LABEL, BOOKING_STATUSES } from '@/domain/booking'
import { KIND_LABEL, TRANSACTION_STATUS_LABEL, TRANSACTION_STATUSES, type TransactionKind } from '@/domain/finance'
import { REQUEST_STATUS_LABEL, REQUEST_STATUSES } from '@/domain/hr'
import type { Scope } from '@/domain/property'
import { cn } from '@/lib/cn'
import { addDays, shortDay } from '@/lib/dates'
import { money, moneyCompact, percent } from '@/lib/format'
import { ColumnChart } from '../../charts/ColumnChart'
import { seriesColor } from '../../charts/colors'
import { LineChart } from '../../charts/LineChart'
import { useAccess } from '../../hooks/useAccess'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { buttonStyles } from '../../ui/buttonStyles'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { ListTable, type Column } from '../../ui/ListTable'
import { PageBar } from '../../ui/PageBar'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { TableToolbar } from '../../ui/TableToolbar'
import { ViewToggle } from '../../ui/ViewToggle'
import { ScopePicker } from '../shared/ScopePicker'
import { chartShape, perDay, searchRows, topRows } from './chartShape'
import { DonutLegend } from './DonutLegend'

const TOP_OPTIONS = [
  { value: '', label: 'All rows' },
  { value: '10', label: 'Top 10' },
  { value: '25', label: 'Top 25' },
]

/** A number or money cell as text, for chips and chart chips. */
const show = (c: ReportColumn, v: string | number | null) => (c.kind === 'money' ? money(Number(v) || 0) : c.kind === 'percent' ? percent(Number(v) || 0) : c.kind === 'date' ? shortDay(String(v)) : String(v ?? ''))

const FILTER_KEYS = ['from', 'to', 'location', 'villa', 'unit', 'source', 'kind', 'status'] as const

function cellOf(c: ReportColumn, v: string | number | null) {
  if (v === null || v === '') return <span className="text-muted">–</span>
  if (c.kind === 'money') return <span className="tabular">{money(Number(v))}</span>
  if (c.kind === 'number') return <span className="tabular">{Number.isInteger(Number(v)) ? Number(v) : Number(v).toFixed(1)}</span>
  if (c.kind === 'percent') return <span className="tabular">{percent(Number(v))}</span>
  if (c.kind === 'date') return shortDay(String(v))
  return <span className="line-clamp-2">{String(v)}</span>
}

function columnOf(c: ReportColumn, index: number, total: number): Column<ReportRow> {
  const numeric = c.kind === 'money' || c.kind === 'number' || c.kind === 'percent'
  // Wide reports: text columns after the first few step aside below xl; the CSV keeps every column.
  const hide = total > 8 && index > 2 && c.kind === 'text' ? 'xl' : undefined
  return {
    key: c.key,
    header: c.header,
    align: numeric ? 'right' : 'left',
    hide,
    className: 'whitespace-nowrap',
    cell: (r) => cellOf(c, r[c.key] ?? null),
    value: (r) => r[c.key] ?? '',
    total: c.total ? (sum) => (c.kind === 'money' ? money(sum) : Number.isInteger(sum) ? sum : sum.toFixed(1)) : undefined,
  }
}

/** One page renders every report: the definition picks the controls, the result brings typed columns. */
export default function ReportPage() {
  const { slug = '' } = useParams()
  const { reports, clock } = useServices()
  const { can } = useAccess()
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useLayout()
  const [picked, setPicked] = useState<string | null>(null)
  const def = reportBySlug(slug)
  const today = clock.today()
  const from = params.get('from') ?? addDays(today, -29)
  const to = params.get('to') ?? today
  const pick = (key: string) => params.get(key) || undefined
  const filter: ReportFilter = { from, to, locationId: pick('location'), villaId: pick('villa'), unitId: pick('unit'), source: pick('source'), kind: pick('kind') as TransactionKind | undefined, status: pick('status') }
  const options = useResource('reports.options', () => reports.options())
  const key = FILTER_KEYS.map((k) => params.get(k) ?? '').join('|')
  const result = useResource(`reports.run:${slug}|${key}`, () => (def ? reports.run(slug, filter) : Promise.reject(new Error('Unknown report'))))

  function update(next: Partial<Record<(typeof FILTER_KEYS)[number] | 'q' | 'top', string | undefined>>) {
    setPicked(null)
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  if (!def) {
    return (
      <EmptyState
        title="This report does not exist"
        action={
          <Link to="/reports" className={buttonStyles({ variant: 'solid', size: 'sm' })}>
            All reports
          </Link>
        }
      >
        The link may be old.
      </EmptyState>
    )
  }
  if (!can('reports', 'view')) return <EmptyState title="Reports are not part of your role">Ask the administrator for report access.</EmptyState>
  if (result.status === 'error' && !result.data) return <ErrorState error={result.error} onRetry={result.reload} />
  const o = options.data
  const has = (c: ReportControl) => def.controls.includes(c)
  const scope: Scope = { locationId: filter.locationId, villaId: filter.villaId, unitId: filter.unitId }
  const query = params.get('q') ?? ''
  const top = Number(params.get('top')) || 0
  const active = FILTER_KEYS.some((k) => params.get(k)) || !!query || top > 0
  const r = result.data
  const shape = r ? chartShape(def.columns, r.rows) : null
  const searched = r ? searchRows(r.rows, def.columns, query) : []
  const ranked = topRows(searched, shape?.valueKey?.key ?? null, top)
  const labelOf = (row: ReportRow) => (shape?.labelKey ? String(row[shape.labelKey.key] ?? '') : '')
  const pickedRow = picked ? ranked.find((row) => labelOf(row) === picked) : undefined
  const rows = pickedRow ? [pickedRow] : ranked
  const moneyTotals = r ? def.columns.filter((c) => c.kind === 'money' && c.total).slice(0, 4).map((c) => ({ c, sum: rows.reduce((s, row) => s + (Number(row[c.key]) || 0), 0) })) : []
  const valueOf = (row: ReportRow) => (shape?.valueKey ? Number(row[shape.valueKey.key]) || 0 : 0)
  const fmtValue = (v: number) => (shape?.valueKey?.kind === 'money' ? money(v) : Number.isInteger(v) ? String(v) : v.toFixed(1))
  const series = shape?.kind === 'line' && shape.labelKey && shape.valueKey ? perDay(ranked, shape.labelKey.key, shape.valueKey.key) : []

  const statusOptions = has('transactionStatus')
    ? TRANSACTION_STATUSES.map((s) => ({ value: s, label: TRANSACTION_STATUS_LABEL[s] }))
    : has('bookingStatus')
      ? BOOKING_STATUSES.map((s) => ({ value: s, label: BOOKING_STATUS_LABEL[s] }))
      : has('requestStatus')
        ? REQUEST_STATUSES.map((s) => ({ value: s, label: REQUEST_STATUS_LABEL[s] }))
        : null

  return (
    <>
      <PageBar fallback="/reports" label="Reports" />
      <div className="space-y-4">
        <p className="max-w-2xl text-sm text-muted">{def.blurb}</p>
        {moneyTotals.length > 0 && (
          <div className="grid grid-cols-1 gap-3 stagger sm:grid-cols-2 xl:grid-cols-4">
            {moneyTotals.map(({ c, sum }) => (
              <div key={c.key} className="min-w-0 rounded-card border border-line bg-card p-5 shadow-card">
                <p className="text-sm text-muted">{c.header}</p>
                <p className="mt-3 min-w-0 text-2xl leading-none font-medium tracking-tight break-words tabular">{money(sum)}</p>
                <p className="mt-2 text-xs text-muted">
                  {shortDay(from)} to {shortDay(to)}
                </p>
              </div>
            ))}
          </div>
        )}
        {r && shape && shape.kind !== 'none' && layout === 'cards' && (
          <div className={cn('grid grid-cols-1 gap-4', shape.shareKey && shape.kind === 'columns' && 'xl:grid-cols-[minmax(0,1fr)_380px]')}>
            <Card aria-labelledby="report-chart">
              <CardHeader
                id="report-chart"
                title={`${shape.valueKey?.header ?? ''} by ${shape.labelKey?.header.toLowerCase() ?? ''}`}
                action={
                  pickedRow ? (
                    <Button size="sm" variant="soft" onClick={() => setPicked(null)}>
                      Show all
                    </Button>
                  ) : (
                    <span className="text-xs text-muted">{shape.kind === 'columns' ? 'Click a column to focus the table' : `${series.length} days`}</span>
                  )
                }
              />
              {shape.kind === 'columns' ? (
                <ColumnChart
                  label={`${shape.valueKey?.header} by ${shape.labelKey?.header}`}
                  className="h-56"
                  data={ranked.map((row) => ({ key: labelOf(row), label: labelOf(row), value: Math.abs(valueOf(row)) }))}
                  selected={picked}
                  onSelect={(key) => setPicked(picked === key ? null : key)}
                  format={fmtValue}
                  tick={(v) => (shape.valueKey?.kind === 'money' ? moneyCompact(v) : String(v))}
                />
              ) : (
                <LineChart label={`${shape.valueKey?.header} per day`} labels={series.map((p) => shortDay(p.date).replace(/^\w+ /, ''))} series={[{ id: 'v', label: shape.valueKey?.header ?? '', values: series.map((p) => p.value), color: seriesColor(1), area: true }]} format={fmtValue} tick={(v) => (shape.valueKey?.kind === 'money' ? moneyCompact(v) : String(v))} />
              )}
              {pickedRow && (
                <dl className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 stagger">
                  {def.columns.slice(1, 9).map((c) => (
                    <div key={c.key} className="min-w-0 rounded-panel bg-raised p-2.5">
                      <dt className="truncate text-muted">{c.header}</dt>
                      <dd className="mt-0.5 truncate font-medium tabular">{show(c, pickedRow[c.key] ?? null)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
            {shape.shareKey && shape.kind === 'columns' && (
              <Card aria-labelledby="report-share">
                <CardHeader id="report-share" title={shape.shareKey.header} />
                <DonutLegend
                  label={`${shape.shareKey.header} by ${shape.labelKey?.header}`}
                  format={(v) => percent(v, { digits: 0 })}
                  centre={<p className="text-sm text-muted">{ranked.length} rows</p>}
                  picked={picked}
                  onPick={(id) => setPicked(picked === id ? null : id)}
                  slices={ranked.map((row, i) => ({ id: labelOf(row), label: labelOf(row), value: Math.max(0, Number(row[shape.shareKey?.key ?? '']) || 0), color: seriesColor((i % 5) + 1) }))}
                />
              </Card>
            )}
          </div>
        )}
        <Card className="p-0" aria-label={def.title}>
          <TableToolbar
            summary={r ? `${rows.length} of ${r.rows.length} rows` : 'Loading'}
            search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Search the rows" aria-label="Search the report" value={query} onChange={(e) => update({ q: e.target.value })} />}
            filters={
              <>
                {shape?.valueKey && <Select aria-label="Rows to keep" value={top ? String(top) : ''} options={TOP_OPTIONS} onChange={(e) => update({ top: e.target.value })} />}
                {shape && shape.kind !== 'none' && <ViewToggle value={layout} onChange={setLayout} cardsLabel="Chart" />}
                {has('scope') && o && <ScopePicker catalog={o.catalog} value={scope} onChange={(s) => update({ location: s.locationId, villa: s.villaId, unit: s.unitId })} className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:min-w-[27rem]" />}
                {has('source') && o && <Select aria-label="Source" value={filter.source ?? ''} options={[{ value: '', label: 'All sources' }, ...o.sources.map((s) => ({ value: s.id, label: s.label }))]} onChange={(e) => update({ source: e.target.value })} />}
                {has('kind') && <Select aria-label="Kind" value={filter.kind ?? ''} options={[{ value: '', label: 'In and out' }, { value: 'cash_in', label: KIND_LABEL.cash_in }, { value: 'cash_out', label: KIND_LABEL.cash_out }]} onChange={(e) => update({ kind: e.target.value })} />}
                {statusOptions && <Select aria-label="Status" value={filter.status ?? ''} options={[{ value: '', label: 'Any status' }, ...statusOptions]} onChange={(e) => update({ status: e.target.value })} />}
              </>
            }
            date={<DateRangeFilter today={today} label="Date" value={{ from, to }} onChange={(range) => update({ from: range.from, to: range.to })} />}
            active={active}
            onClear={() => setParams({}, { replace: true })}
          />
          {!r ? (
            <div className="p-4">
              <CardSkeleton lines={6} />
            </div>
          ) : (
            <div className="overflow-x-auto">
            <ListTable
              label={def.title}
              rows={rows}
              rowKey={(row) => JSON.stringify(row)}
              href={() => `/reports/${slug}?${params.toString()}`}
              columns={def.columns.map((c, i) => columnOf(c, i, def.columns.length))}
              exportName={`report-${slug}`}
              exportDate={today}
              exportLabel="Export to Excel (CSV)"
              empty={<EmptyState title="Nothing in this range">Widen the dates or clear the filters.</EmptyState>}
              card={(row) => {
                const [first, ...rest] = def.columns
                return (
                  <div className="min-w-0">
                    <p className="truncate font-medium">{first ? cellOf(first, row[first.key] ?? null) : ''}</p>
                    <p className="line-clamp-2 text-xs text-muted">
                      {rest
                        .slice(0, 4)
                        .map((c) => `${c.header}: ${c.kind === 'money' ? money(Number(row[c.key]) || 0) : c.kind === 'percent' ? percent(Number(row[c.key]) || 0) : String(row[c.key] ?? '')}`)
                        .join(' · ')}
                    </p>
                  </div>
                )
              }}
            />
            </div>
          )}
        </Card>
        <p className="text-xs text-muted">
          Printed from Bali Villa Console on {shortDay(today)}. Figures cover {shortDay(from)} to {shortDay(to)}.
        </p>
      </div>
    </>
  )
}
