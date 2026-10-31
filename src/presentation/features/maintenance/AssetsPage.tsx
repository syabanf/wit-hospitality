import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Plus, Search } from 'lucide-react'
import { ASSET_STATUS_LABEL, ASSET_STATUSES, MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, type AssetStatus } from '@/domain/maintenance'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { AssetForm } from './AssetForm'
import { ASSET_TONE } from './tones'

type Chip = AssetStatus | 'all'
const CHIPS: readonly Chip[] = ['all', ...ASSET_STATUSES]

/** Equipment per unit and villa: repairs, cost to date and warranty. */
export default function AssetsPage() {
  const { maintenance, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('maintenance.assets', () => maintenance.assets())
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const chip = (CHIPS.find((c) => c === params.get('status')) ?? 'all') as Chip
  const get = (k: string) => params.get(k) ?? ''

  function update(next: Record<string, string>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    search.delete('page')
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const q = get('q').toLowerCase()
  const base = d.assets.filter((a) => (!get('villa') || a.villaId === get('villa')) && (!get('category') || a.category === get('category')) && (get('warranty') !== 'in' || a.inWarranty) && (!q || [a.code, a.name, a.brand, a.model, a.serial, a.unitCode].some((v) => v.toLowerCase().includes(q))))
  const rows = chip === 'all' ? base : base.filter((a) => a.status === chip)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Every AC, pump, heater and motor with its repairs. Rows open the asset and its job history.</p>
        {can('maintenance', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Asset
          </Button>
        )}
      </div>
      {adding && (
        <AssetForm
          catalog={d.catalog}
          save={(input) => maintenance.createAsset(input)}
          onDone={() => {
            toast({ title: 'Registered the asset' })
            setAdding(false)
            data.reload()
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      <div className="stagger grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile label="Assets" value={d.assets.length} hint={`${d.assets.filter((a) => a.status === 'in_service').length} in service`} active={chip === 'all'} onClick={() => update({ status: '' })} />
        <StatTile label="Under repair" value={d.assets.filter((a) => a.status === 'under_repair').length} active={chip === 'under_repair'} onClick={() => update({ status: chip === 'under_repair' ? '' : 'under_repair' })} />
        <StatTile className="col-span-2 sm:col-span-1" label="In warranty" value={d.assets.filter((a) => a.inWarranty).length} hint="Claim before paying" active={get('warranty') === 'in'} onClick={() => update({ warranty: get('warranty') === 'in' ? '' : 'in' })} />
        <StatTile className="col-span-2 sm:col-span-1" label="Repair cost to date" value={money(d.assets.reduce((s, a) => s + a.costToDate, 0))} hint="Jobs linked to an asset" />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={CHIPS.map((c) => ({ value: c, label: c === 'all' ? 'All' : ASSET_STATUS_LABEL[c], count: c === 'all' ? base.length : base.filter((a) => a.status === c).length }))}
          chip={chip}
          onChip={(c) => update({ status: c === 'all' ? '' : c })}
          summary={`${rows.length} of ${d.assets.length} assets`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Code, name, brand or serial" aria-label="Search assets" value={get('q')} onChange={(e) => update({ q: e.target.value })} />}
          filters={
            <>
              <Select aria-label="Villa" value={get('villa')} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => update({ villa: e.target.value })} />
              <Select aria-label="Category" value={get('category')} options={[{ value: '', label: 'All categories' }, ...MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))]} onChange={(e) => update({ category: e.target.value })} />
            </>
          }
          active={chip !== 'all' || ['villa', 'category', 'q', 'warranty'].some((k) => get(k))}
          onClear={() => setParams({}, { replace: true })}
        />
        <ListTable
          label="Assets"
          rows={rows}
          rowKey={(a) => a.id}
          href={(a) => `/maintenance/assets/${a.id}`}
          defaultSort={{ key: 'code', dir: 'asc' }}
          exportName="assets"
          exportDate={clock.today()}
          empty={<EmptyState title="No asset matches" />}
          columns={[
            { key: 'code', header: 'Code', cell: (a) => <span className="font-mono">{a.code}</span>, value: (a) => a.code },
            { key: 'name', header: 'Asset', cell: (a) => a.name, value: (a) => a.name, hide: 'lg' },
            { key: 'where', header: 'Where', cell: (a) => a.unitCode || a.villaName, value: (a) => a.unitCode || a.villaName },
            { key: 'brand', header: 'Brand', cell: (a) => `${a.brand} ${a.model}`.trim(), value: (a) => a.brand, hide: 'xl' },
            { key: 'warranty', header: 'Warranty', cell: (a) => (a.warrantyUntil ? <Tag tone={a.inWarranty ? 'success' : 'neutral'}>{a.inWarranty ? `Until ${shortDay(a.warrantyUntil)}` : 'Expired'}</Tag> : 'None'), value: (a) => a.warrantyUntil ?? '', hide: 'xl' },
            { key: 'jobs', header: 'Jobs', align: 'right', cell: (a) => <span className="tabular">{a.workOrders}</span>, value: (a) => a.workOrders, total: (sum) => sum },
            { key: 'status', header: 'Status', cell: (a) => <StatusPill tone={ASSET_TONE[a.status]}>{ASSET_STATUS_LABEL[a.status]}</StatusPill>, value: (a) => a.status },
            { key: 'cost', header: 'Repairs', align: 'right', cell: (a) => <span className="tabular">{money(a.costToDate)}</span>, value: (a) => a.costToDate, total: (sum) => money(sum), hide: 'lg' },
          ]}
          card={(a) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{a.name}</p>
                <p className="truncate text-xs text-muted">
                  <span className="font-mono">{a.code}</span> · {a.workOrders} jobs · {money(a.costToDate)}
                </p>
              </div>
              <StatusPill tone={ASSET_TONE[a.status]}>{ASSET_STATUS_LABEL[a.status]}</StatusPill>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
