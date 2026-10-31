import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Plus, Search } from 'lucide-react'
import type { WorkOrderView } from '@/application/views'
import { isOpenWorkOrder, MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, PRIORITY_LABEL, WORK_ORDER_PRIORITIES, WORK_ORDER_STATUS_LABEL, WORK_ORDER_STATUSES, type MaintenanceCategory, type WorkOrderPriority, type WorkOrderStatus } from '@/domain/maintenance'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useLayout } from '../../hooks/useLayout'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card } from '../../ui/Card'
import { DateRangeFilter } from '../../ui/DateRangeFilter'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { ViewToggle } from '../../ui/ViewToggle'
import { ScopePicker } from '../shared/ScopePicker'
import { WorkOrderBoard } from './WorkOrderBoard'
import { WorkOrderTable } from './WorkOrderTable'

type Chip = WorkOrderStatus | 'all' | 'active'
const CHIPS: readonly Chip[] = ['active', 'all', ...WORK_ORDER_STATUSES]
const KEYS = ['status', 'priority', 'category', 'location', 'villa', 'unit', 'who', 'q', 'from', 'to'] as const

/** Every job on a board or in a table, with the filters an owner asks for kept in the URL. */
export default function WorkOrdersPage() {
  const { maintenance, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('maintenance.workOrders', () => maintenance.workOrders())
  const [params, setParams] = useSearchParams()
  const [layout, setLayout] = useLayout()
  const [busy, setBusy] = useState<string | null>(null)
  const get = (k: (typeof KEYS)[number]) => params.get(k) ?? ''
  const status = (CHIPS.find((c) => c === params.get('status')) ?? 'active') as Chip
  const who = get('who')

  function update(next: Partial<Record<(typeof KEYS)[number], string>>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  async function move(w: WorkOrderView, to: Exclude<WorkOrderStatus, 'open'>) {
    setBusy(w.id)
    try {
      await maintenance.transition(w.id, to)
      toast({ title: `${w.number} ${WORK_ORDER_STATUS_LABEL[to].toLowerCase()}`, description: w.title })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not move ${w.number}`, description: Object.values(fieldErrors(error))[0] })
    } finally {
      setBusy(null)
    }
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const base = maintenance.filter(d.list, {
    priority: get('priority') as WorkOrderPriority | '',
    category: get('category') as MaintenanceCategory | '',
    locationId: get('location') || undefined,
    villaId: get('villa') || undefined,
    unitId: get('unit') || undefined,
    assigneeId: who.startsWith('emp:') ? who.slice(4) : undefined,
    vendorId: who.startsWith('ven:') ? who.slice(4) : undefined,
    query: get('q'),
    from: get('from') || undefined,
    to: get('to') || undefined,
  })
  const rows = maintenance.filter(base, { status })
  const open = base.filter(isOpenWorkOrder)
  const active = KEYS.some((k) => k !== 'status' && params.get(k)) || status !== 'active'

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Repairs and services per unit and per villa. Drag a card to the next column or use its button; the record keeps parts, costs and photos.</p>
        <div className="flex flex-wrap gap-2">
          <ViewToggle value={layout} onChange={setLayout} cardsLabel="Board" />
          {can('maintenance', 'create') && (
            <Link to="/maintenance/work-orders/new" className={buttonStyles({ variant: 'accent' })}>
              <Plus aria-hidden className="size-4" /> New work order
            </Link>
          )}
        </div>
      </div>
      <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Open" value={open.length} hint="Matching the filters" active={status === 'active'} onClick={() => update({ status: '' })} />
        <StatTile label="Urgent or high" value={open.filter((w) => w.priority === 'urgent' || w.priority === 'high').length} hint="Still open" active={get('priority') === 'urgent'} onClick={() => update({ priority: get('priority') === 'urgent' ? '' : 'urgent' })} />
        <StatTile className="col-span-2 sm:col-span-1" label="Past the scheduled date" value={open.filter((w) => w.late).length} hint="Open and late" />
        <StatTile className="col-span-2 sm:col-span-1" label="Cost of these jobs" value={money(rows.reduce((s, w) => s + w.total, 0))} hint={`${rows.length} jobs`} />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : c === 'active' ? 'Active' : WORK_ORDER_STATUS_LABEL[c], count: c === 'all' ? base.length : c === 'active' ? open.length : base.filter((w) => w.status === c).length }))}
          chip={status}
          onChip={(c) => update({ status: c === 'active' ? '' : c })}
          summary={`${rows.length} of ${d.list.length} jobs`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Number, job, unit or person" aria-label="Search work orders" value={get('q')} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Priority" value={get('priority')} options={[{ value: '', label: 'Any priority' }, ...WORK_ORDER_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))]} onChange={(e) => update({ priority: e.target.value })} />
              <Select aria-label="Category" value={get('category')} options={[{ value: '', label: 'All categories' }, ...MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))]} onChange={(e) => update({ category: e.target.value })} />
              <Select
                aria-label="Assigned to"
                value={who}
                options={[{ value: '', label: 'Anyone' }, ...d.employees.filter((e) => d.list.some((w) => w.assigneeId === e.id)).map((e) => ({ value: `emp:${e.id}`, label: e.name })), ...d.vendors.map((v) => ({ value: `ven:${v.id}`, label: v.name }))]}
                onChange={(e) => update({ who: e.target.value })}
              />
              <ScopePicker catalog={d.catalog} value={{ locationId: get('location') || undefined, villaId: get('villa') || undefined, unitId: get('unit') || undefined }} onChange={(sc) => update({ location: sc.locationId ?? '', villa: sc.villaId ?? '', unit: sc.unitId ?? '' })} className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:min-w-[27rem]" />
            </>
          }
          date={<DateRangeFilter today={clock.today()} label="Reported" value={{ from: get('from') || undefined, to: get('to') || undefined }} onChange={(r) => update({ from: r.from ?? '', to: r.to ?? '' })} />}
          active={active}
          onClear={() => setParams(params.get('layout') ? { layout: params.get('layout') as string } : {}, { replace: true })}
        />
        {layout === 'table' ? (
          <WorkOrderTable label="Work orders" rows={rows} exportName="work-orders" exportDate={clock.today()} empty={<EmptyState title="No job matches" action={<Button size="sm" variant="solid" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>}>Nothing fits these filters.</EmptyState>} />
        ) : (
          <WorkOrderBoard rows={rows.filter((w) => w.status !== 'cancelled')} busy={busy} canEdit={can('maintenance', 'edit')} canVerify={can('maintenance', 'approve')} onMove={(w, to) => void move(w, to)} />
        )}
      </Card>
    </div>
  )
}
