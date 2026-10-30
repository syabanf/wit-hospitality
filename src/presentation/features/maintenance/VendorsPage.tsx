import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { Plus, Search } from 'lucide-react'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL } from '@/domain/maintenance'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { ListTable } from '../../ui/ListTable'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { TableToolbar } from '../../ui/TableToolbar'
import { useToast } from '../../ui/useToast'
import { VendorForm } from './VendorForm'

type Chip = 'all' | 'active' | 'inactive'

/** Contractors with their trade, open jobs and spend. */
export default function VendorsPage() {
  const { maintenance, clock } = useServices()
  const { can } = useAccess()
  const toast = useToast()
  const data = useResource('maintenance.vendors', () => maintenance.vendors())
  const [params, setParams] = useSearchParams()
  const [adding, setAdding] = useState(false)
  const chip = (['all', 'active', 'inactive'].find((c) => c === params.get('state')) ?? 'all') as Chip
  const get = (k: string) => params.get(k) ?? ''

  function update(next: Record<string, string>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={6} />
  const d = data.data
  const q = get('q').toLowerCase()
  const base = d.vendors.filter((v) => (!get('trade') || v.trade === get('trade')) && (!q || [v.name, v.contact, v.phone, v.email].some((x) => x.toLowerCase().includes(q))))
  const rows = chip === 'all' ? base : base.filter((v) => v.active === (chip === 'active'))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">The contractors the villas call. Rows open the vendor with every job and the spend.</p>
        {can('maintenance', 'create') && (
          <Button variant="accent" aria-pressed={adding} onClick={() => setAdding((v) => !v)}>
            <Plus aria-hidden className="size-4" /> Vendor
          </Button>
        )}
      </div>
      {adding && (
        <VendorForm
          save={(input) => maintenance.createVendor(input)}
          onDone={() => {
            toast({ title: 'Added the vendor' })
            setAdding(false)
            data.reload()
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Vendors" value={d.vendors.filter((v) => v.active).length} hint="Active" />
        <StatTile label="Open jobs with vendors" value={d.vendors.reduce((s, v) => s + v.openJobs, 0)} />
        <StatTile label="Spend on file" value={money(d.vendors.reduce((s, v) => s + v.spend, 0))} />
      </div>
      <Card className="p-0">
        <TableToolbar
          chips={(['all', 'active', 'inactive'] as Chip[]).map((c) => ({ value: c, label: c === 'all' ? 'All' : c === 'active' ? 'Active' : 'Inactive', count: c === 'all' ? base.length : base.filter((v) => v.active === (c === 'active')).length }))}
          chip={chip}
          onChip={(c) => update({ state: c === 'all' ? '' : c })}
          summary={`${rows.length} vendors`}
          search={<Input className="h-10" icon={<Search className="size-4" />} placeholder="Name, contact or phone" aria-label="Search vendors" value={get('q')} onChange={(e) => update({ q: e.target.value })} />}
          filters={<Select aria-label="Trade" value={get('trade')} options={[{ value: '', label: 'All trades' }, ...MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))]} onChange={(e) => update({ trade: e.target.value })} />}
          active={chip !== 'all' || !!get('trade') || !!q}
          onClear={() => setParams({}, { replace: true })}
        />
        <ListTable
          label="Vendors"
          rows={rows}
          rowKey={(v) => v.id}
          href={(v) => `/maintenance/vendors/${v.id}`}
          defaultSort={{ key: 'spend', dir: 'desc' }}
          exportName="vendors"
          exportDate={clock.today()}
          empty={<EmptyState title="No vendor matches" />}
          columns={[
            { key: 'name', header: 'Vendor', cell: (v) => v.name, value: (v) => v.name },
            { key: 'trade', header: 'Trade', cell: (v) => MAINTENANCE_CATEGORY_LABEL[v.trade], value: (v) => v.trade },
            { key: 'contact', header: 'Contact', cell: (v) => <span className="text-muted">{[v.contact, v.phone].filter(Boolean).join(' · ')}</span>, value: (v) => v.contact, hide: 'xl' },
            { key: 'rate', header: 'Rate', cell: (v) => <span className="line-clamp-1 text-muted">{v.rateNote}</span>, value: (v) => v.rateNote, hide: 'xl' },
            { key: 'jobs', header: 'Jobs', align: 'right', cell: (v) => <span className="tabular">{v.workOrders}</span>, value: (v) => v.workOrders, total: (sum) => sum },
            { key: 'active', header: 'Status', cell: (v) => <Tag tone={v.active ? 'success' : 'neutral'}>{v.active ? 'Active' : 'Inactive'}</Tag>, value: (v) => (v.active ? 1 : 0), hide: 'lg' },
            { key: 'spend', header: 'Spend', align: 'right', cell: (v) => <span className="tabular">{money(v.spend)}</span>, value: (v) => v.spend, total: (sum) => money(sum) },
          ]}
          card={(v) => (
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{v.name}</p>
                <p className="truncate text-xs text-muted">
                  {MAINTENANCE_CATEGORY_LABEL[v.trade]} · {v.workOrders} jobs · {money(v.spend)}
                </p>
              </div>
              <Tag tone={v.active ? 'success' : 'neutral'}>{v.active ? 'Active' : 'Inactive'}</Tag>
            </div>
          )}
        />
      </Card>
    </div>
  )
}
