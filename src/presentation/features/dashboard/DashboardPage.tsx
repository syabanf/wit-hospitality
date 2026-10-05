import { useSearchParams } from 'react-router'
import { PERIOD_LABEL, PERIODS, type Period } from '@/domain/dashboard'
import type { Scope } from '@/domain/property'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Select } from '../../ui/Field'
import { Skeleton } from '../../ui/States'
import { Tabs } from '../../ui/Tabs'
import { ViewToggle } from '../../ui/ViewToggle'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { ScopePicker } from '../shared/ScopePicker'
import { ExecutiveView } from './ExecutiveView'
import { FinancialView } from './FinancialView'
import { OperationalView } from './OperationalView'
import { parseState, serializeState, VIEWS, type DashboardState } from './filters'

const PERIOD_OPTIONS = PERIODS.map((value) => ({ value, label: PERIOD_LABEL[value] }))

/** Three dashboards behind one filter bar: period, location, villa, unit and booking source. */
export default function DashboardPage() {
  const { dashboard, clock } = useServices()
  const [params, setParams] = useSearchParams()
  const state = parseState(params)
  const options = useResource('dashboard.filterOptions', () => dashboard.filterOptions())
  const [layout, setLayout] = useLayout()

  const update = (next: Partial<DashboardState>) => {
    const search = serializeState({ ...state, ...next })
    if (layout === 'table') search.set('layout', 'table')
    setParams(search, { replace: true })
  }
  const scope: Scope = { locationId: state.locationId, villaId: state.villaId, unitId: state.unitId }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs label="Dashboard" options={VIEWS} value={state.view} onChange={(view) => update({ view })} />
        <ViewToggle value={layout} onChange={setLayout} className="ml-auto" />
        <Tabs label="Period" variant="underline" options={PERIOD_OPTIONS} value={state.period} onChange={(period: Period) => update({ period, from: undefined, to: undefined })} className={state.from || state.to ? 'opacity-60' : undefined} />
      </div>
      <DateRangeFilter today={clock.today()} tone="card" label="Period" value={{ from: state.from, to: state.to }} onChange={(r) => update({ from: r.from, to: r.to })} />
      {options.data ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <ScopePicker
            catalog={options.data.catalog}
            value={scope}
            tone="card"
            onChange={(s) => update({ locationId: s.locationId, villaId: s.villaId, unitId: s.unitId })}
            className="contents"
          />
          {state.view !== 'financial' ? (
            <Select
              aria-label="Booking source"
              tone="card"
              className="w-full"
              value={state.source ?? ''}
              options={[{ value: '', label: 'All sources' }, ...options.data.sources.map((s) => ({ value: s.id, label: s.label }))]}
              onChange={(e) => update({ source: e.target.value || undefined })}
            />
          ) : (
            <span className="hidden h-10 items-center rounded-full border border-dashed border-line-strong px-4 text-xs text-muted sm:inline-flex">Source does not apply to cash</span>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-10 rounded-full" />
          ))}
        </div>
      )}
      {state.view === 'executive' && <ExecutiveView filter={state} layout={layout} />}
      {state.view === 'operational' && <OperationalView filter={state} layout={layout} />}
      {state.view === 'financial' && <FinancialView filter={state} layout={layout} />}
    </div>
  )
}
