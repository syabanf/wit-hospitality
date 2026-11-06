import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ArrowLeftRight, ClipboardCheck, PackagePlus, PackageMinus, Pencil, Plus, Trash2 } from 'lucide-react'
import { TRANSACTION_STATUS_LABEL } from '@/domain/finance'
import { MOVEMENT_KIND_LABEL, MOVEMENT_KINDS, STOCK_KIND_LABEL, type MoveKind, type MovementKind, type StockItem } from '@/domain/stock'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useAccess } from '../../hooks/useAccess'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { StatusPill, Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { buttonStyles } from '../../ui/buttonStyles'
import { Card, CardHeader } from '../../ui/Card'
import { DataTable } from '../../ui/DataTable'
import { Select } from '../../ui/Field'
import { CardSkeleton, EmptyState, ErrorState } from '../../ui/States'
import { StatTile } from '../../ui/StatTile'
import { Tabs } from '../../ui/Tabs'
import { TRANSACTION_TONE } from '../shared/tones'
import { CountForm, ItemForm, MoveForm, ReceiptForm } from './StockForms'
import { KitsCard, MinibarLinksCard } from './StockSetup'

type Tab = 'stores' | 'movements' | 'receipts' | 'counts' | 'items' | 'kits'
const TABS: ReadonlyArray<{ value: Tab; label: string }> = [
  { value: 'stores', label: 'Villa stores' },
  { value: 'movements', label: 'Movements' },
  { value: 'receipts', label: 'Receipts' },
  { value: 'counts', label: 'Counts' },
  { value: 'items', label: 'Items' },
  { value: 'kits', label: 'Kits and minibar' },
]
type Form = 'receive' | MoveKind | 'count' | 'item' | null

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

/** Minibar goods, amenities and linen per villa store: levels, movements, purchases, counts and kits. */
export default function StockPage() {
  const { stock } = useServices()
  const { can } = useAccess()
  const data = useResource('stock.overview', () => stock.overview())
  const [params, setParams] = useSearchParams()
  const [form, setForm] = useState<Form>(null)
  const [editItem, setEditItem] = useState<StockItem | null>(null)
  const tab = (TABS.find((t) => t.value === params.get('tab'))?.value ?? 'stores') as Tab
  const villaId = params.get('villa') ?? ''
  const kind = (params.get('kind') ?? '') as MovementKind | ''

  function update(next: Record<string, string>) {
    const search = new URLSearchParams(params)
    for (const [k, v] of Object.entries(next)) {
      if (v) search.set(k, v)
      else search.delete(k)
    }
    setParams(search, { replace: true })
  }

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={8} />
  const d = data.data
  const done = () => {
    setForm(null)
    setEditItem(null)
    data.reload()
  }
  const stores = d.stores.filter((s) => s.levels.length > 0 && (!villaId || s.villa.id === villaId))
  const movements = d.movements.filter((m) => (!villaId || m.villaId === villaId) && (!kind || m.kind === kind))
  const awaiting = d.receipts.filter((r) => r.entry && (r.entry.status === 'submitted' || r.entry.status === 'approved'))
  const formProps = { catalog: d.catalog, items: d.items, villaId, onDone: done, onCancel: () => setForm(null) }
  const canEdit = can('maintenance', 'edit')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted">Each villa keeps its own store. On hand comes from every receipt, issue, sale, count, transfer and write-off.</p>
        <div className="flex flex-wrap gap-2">
          {can('maintenance', 'submit') && (
            <Button variant="accent" aria-pressed={form === 'receive'} onClick={() => setForm(form === 'receive' ? null : 'receive')}>
              <PackagePlus aria-hidden className="size-4" /> Receive
            </Button>
          )}
          {canEdit && (
            <>
              <Button variant="card" aria-pressed={form === 'issue'} onClick={() => setForm(form === 'issue' ? null : 'issue')}>
                <PackageMinus aria-hidden className="size-4" /> Issue
              </Button>
              <Button variant="card" aria-pressed={form === 'transfer'} onClick={() => setForm(form === 'transfer' ? null : 'transfer')}>
                <ArrowLeftRight aria-hidden className="size-4" /> Transfer
              </Button>
              <Button variant="card" aria-pressed={form === 'write_off'} onClick={() => setForm(form === 'write_off' ? null : 'write_off')}>
                <Trash2 aria-hidden className="size-4" /> Write off
              </Button>
              <Button variant="card" aria-pressed={form === 'count'} onClick={() => setForm(form === 'count' ? null : 'count')}>
                <ClipboardCheck aria-hidden className="size-4" /> Count
              </Button>
            </>
          )}
        </div>
      </div>

      {form === 'receive' && <ReceiptForm {...formProps} />}
      {(form === 'issue' || form === 'transfer' || form === 'write_off') && <MoveForm key={form} kind={form} {...formProps} />}
      {form === 'count' && <CountForm {...formProps} />}
      {(form === 'item' || editItem) && <ItemForm key={editItem?.id ?? 'new'} initial={editItem ?? undefined} onDone={done} onCancel={done} />}

      <div className="stagger grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Stock value" value={money(stores.reduce((s, x) => s + x.value, 0))} hint="At the average cost" />
        <StatTile label="Low items" value={d.low.filter((l) => !villaId || l.villaId === villaId).length} hint="At or under the reorder level" onClick={() => update({ tab: 'stores' })} />
        <StatTile label="Purchases in approval" value={money(awaiting.reduce((s, r) => s + r.total, 0))} hint={`${awaiting.length} receipts`} onClick={() => update({ tab: 'receipts' })} />
        <StatTile label="Movements today" value={d.movements.filter((m) => m.on === d.today && (!villaId || m.villaId === villaId)).length} onClick={() => update({ tab: 'movements' })} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs label="Stock views" options={TABS} value={tab} onChange={(t) => update({ tab: t === 'stores' ? '' : t })} className="max-w-full overflow-x-auto" />
        <Select aria-label="Villa" value={villaId} options={[{ value: '', label: 'All villas' }, ...d.catalog.villas.map((v) => ({ value: v.id, label: v.name }))]} onChange={(e) => update({ villa: e.target.value })} />
      </div>

      {tab === 'stores' &&
        (stores.length === 0 ? (
          <EmptyState title="No store holds stock here" />
        ) : (
          stores.map((s) => (
            <Card key={s.villa.id} aria-labelledby={`store-${s.villa.id}`}>
              <CardHeader id={`store-${s.villa.id}`} title={s.villa.name} action={<span className="text-sm text-muted tabular">{money(s.value)}</span>} />
              <DataTable
                label={`${s.villa.name} store`}
                rows={s.levels}
                rowKey={(l) => l.item.id}
                columns={[
                  { key: 'item', header: 'Item', cell: (l) => <span className="font-medium">{l.item.name}</span> },
                  { key: 'kind', header: 'Kind', cell: (l) => <span className="text-muted">{STOCK_KIND_LABEL[l.item.kind]}</span> },
                  { key: 'onHand', header: 'On hand', align: 'right', cell: (l) => `${l.onHand} ${l.item.unit}` },
                  { key: 'reorder', header: 'Reorder at', align: 'right', cell: (l) => l.item.reorderLevel },
                  { key: 'value', header: 'Value', align: 'right', cell: (l) => money(l.value) },
                  { key: 'state', header: '', cell: (l) => (l.low ? <Tag tone="warning">Low</Tag> : null) },
                ]}
              />
            </Card>
          ))
        ))}

      {tab === 'movements' && (
        <Card className="p-0" aria-labelledby="stock-moves">
          <div className="flex flex-wrap items-center justify-between gap-3 p-5 pb-0">
            <CardHeader id="stock-moves" title="Movements" className="mb-0" />
            <div className="flex flex-wrap gap-2">
              <Select aria-label="Movement" compact value={kind} options={[{ value: '', label: 'All movements' }, ...MOVEMENT_KINDS.map((k) => ({ value: k, label: MOVEMENT_KIND_LABEL[k] }))]} onChange={(e) => update({ kind: e.target.value })} />
              <Link to="/reports/stock-movements" className={buttonStyles({ variant: 'soft', size: 'sm' })}>
                Report and CSV
              </Link>
            </div>
          </div>
          <div className="p-5">
            {movements.length === 0 ? (
              <EmptyState title="No movement matches" />
            ) : (
              <DataTable
                label="Stock movements"
                rows={movements.slice(0, 200)}
                rowKey={(m) => m.id}
                columns={[
                  { key: 'on', header: 'Date', cell: (m) => shortDay(m.on) },
                  { key: 'number', header: 'Number', cell: (m) => <span className="font-mono text-xs">{m.number}</span> },
                  { key: 'item', header: 'Item', cell: (m) => <span className="font-medium">{m.itemName}</span> },
                  { key: 'villa', header: 'Store', cell: (m) => m.villaName },
                  { key: 'kind', header: 'Movement', cell: (m) => MOVEMENT_KIND_LABEL[m.kind] },
                  { key: 'where', header: 'Unit or villa', cell: (m) => <span className="text-muted">{m.unitCode || m.otherVillaName}</span> },
                  { key: 'reason', header: 'Reason', cell: (m) => <span className="line-clamp-1 text-muted">{m.reason}</span> },
                  { key: 'qty', header: 'Quantity', align: 'right', cell: (m) => signed(m.quantity) },
                  { key: 'value', header: 'Value', align: 'right', cell: (m) => money(m.value) },
                ]}
              />
            )}
          </div>
        </Card>
      )}

      {tab === 'receipts' && (
        <Card aria-labelledby="stock-receipts">
          <CardHeader id="stock-receipts" title="Receipts" />
          <DataTable
            label="Stock receipts"
            rows={d.receipts.filter((r) => !villaId || r.villaId === villaId)}
            rowKey={(r) => r.id}
            columns={[
              { key: 'on', header: 'Received', cell: (r) => shortDay(r.receivedOn) },
              { key: 'number', header: 'Number', cell: (r) => <span className="font-mono text-xs">{r.number}</span> },
              { key: 'villa', header: 'Store', cell: (r) => r.villaName },
              { key: 'supplier', header: 'Supplier', cell: (r) => r.supplier },
              { key: 'lines', header: 'Items', align: 'right', cell: (r) => r.lines.length },
              { key: 'entry', header: 'Cash-out', cell: (r) => (r.entry ? <Link to={`/finance/transactions/${r.entry.id}`} className="inline-flex items-center gap-2 hover:underline"><span className="font-mono text-xs">{r.entry.number}</span><StatusPill tone={TRANSACTION_TONE[r.entry.status]}>{TRANSACTION_STATUS_LABEL[r.entry.status]}</StatusPill></Link> : <span className="text-muted">Opening stock</span>) },
              { key: 'total', header: 'Total', align: 'right', cell: (r) => money(r.total) },
            ]}
          />
        </Card>
      )}

      {tab === 'counts' && (
        <Card aria-labelledby="stock-counts">
          <CardHeader id="stock-counts" title="Counts" />
          {d.counts.length === 0 ? (
            <EmptyState title="No count yet" />
          ) : (
            <DataTable
              label="Stock counts"
              rows={d.counts.filter((c) => !villaId || c.villaId === villaId)}
              rowKey={(c) => c.id}
              columns={[
                { key: 'on', header: 'Counted', cell: (c) => shortDay(c.countedOn) },
                { key: 'number', header: 'Number', cell: (c) => <span className="font-mono text-xs">{c.number}</span> },
                { key: 'villa', header: 'Store', cell: (c) => c.villaName },
                { key: 'by', header: 'Counted by', cell: (c) => c.countedBy },
                { key: 'lines', header: 'Items counted', align: 'right', cell: (c) => c.lines.length },
                { key: 'changed', header: 'Differences', align: 'right', cell: (c) => c.changed },
                { key: 'variance', header: 'Variance value', align: 'right', cell: (c) => <span className={c.variance < 0 ? 'text-danger' : undefined}>{money(c.variance)}</span> },
              ]}
            />
          )}
        </Card>
      )}

      {tab === 'items' && (
        <Card aria-labelledby="stock-items">
          <CardHeader
            id="stock-items"
            title="Items"
            action={
              can('maintenance', 'create') && (
                <Button size="sm" variant="solid" onClick={() => setForm('item')}>
                  <Plus aria-hidden className="size-3.5" /> Item
                </Button>
              )
            }
          />
          <DataTable
            label="Stock items"
            rows={d.items}
            rowKey={(i) => i.id}
            columns={[
              { key: 'code', header: 'Code', cell: (i) => <span className="font-mono text-xs">{i.code}</span> },
              { key: 'name', header: 'Name', cell: (i) => <span className="font-medium">{i.name}</span> },
              { key: 'kind', header: 'Kind', cell: (i) => STOCK_KIND_LABEL[i.kind] },
              { key: 'unit', header: 'Unit', cell: (i) => i.unit },
              { key: 'reorder', header: 'Reorder at', align: 'right', cell: (i) => i.reorderLevel },
              { key: 'par', header: 'Minibar par', align: 'right', cell: (i) => (i.kind === 'minibar' ? i.par : '') },
              { key: 'cost', header: 'Average cost', align: 'right', cell: (i) => money(i.averageCost) },
              { key: 'state', header: '', cell: (i) => (i.active ? null : <Tag tone="neutral">Inactive</Tag>) },
              {
                key: 'edit',
                header: '',
                cell: (i) =>
                  canEdit && (
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${i.name}`} onClick={() => setEditItem(i)}>
                      <Pencil aria-hidden className="size-4" />
                    </Button>
                  ),
              },
            ]}
          />
        </Card>
      )}

      {tab === 'kits' && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <KitsCard kits={d.kits.filter((k) => !villaId || k.group.villaId === villaId)} items={d.items} canEdit={canEdit} onChanged={data.reload} />
          <MinibarLinksCard links={d.links.filter((l) => !villaId || l.menuItem.villaId === villaId)} items={d.items} canEdit={canEdit} onChanged={data.reload} />
        </div>
      )}
    </div>
  )
}
