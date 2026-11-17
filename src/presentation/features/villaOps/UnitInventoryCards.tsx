import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Copy, Pencil, Plus, Trash2 } from 'lucide-react'
import { CHECK_KIND_LABEL, INVENTORY_CATEGORIES, INVENTORY_CATEGORY_LABEL, linesOff, type InventoryCategory, type UnitItem } from '@/domain/unitInventory'
import { shortDay } from '@/lib/dates'
import { money } from '@/lib/format'
import { useResource } from '../../hooks/useResource'
import { useServices } from '../../hooks/useServices'
import { Tag } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { Field } from '../../ui/Form'
import { fieldErrors } from '../../ui/fieldErrors'
import { CardSkeleton, ErrorState } from '../../ui/States'
import { useToast } from '../../ui/useToast'
import { PhotoField } from '../maintenance/PhotoField'

function ItemForm({ unitId, initial, onDone, onCancel }: { unitId: string; initial: UnitItem | null; onDone: (name: string) => void; onCancel: () => void }) {
  const { villaOps } = useServices()
  const [photo, setPhoto] = useState<string[]>(initial?.photo ? [initial.photo] : [])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const id = initial?.id ?? 'new'

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      const saved = await villaOps.saveUnitItem(initial?.id ?? null, {
        unitId,
        name: String(f.get('name')),
        category: f.get('category') as InventoryCategory,
        expected: Number(f.get('expected')),
        condition: String(f.get('condition') ?? ''),
        photo: photo.at(-1) ?? null,
        replacementCost: Number(f.get('cost')),
      })
      onDone(saved.name)
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mb-4 grid grid-cols-1 gap-3 rounded-panel bg-raised p-4 sm:grid-cols-2" aria-label={initial ? `Edit ${initial.name}` : 'Add an item'}>
      <Field label="Item" htmlFor={`item-name-${id}`} error={errors.name ?? errors.form}>
        <Input id={`item-name-${id}`} name="name" defaultValue={initial?.name} placeholder="Wine glass" required />
      </Field>
      <Field label="Category" htmlFor={`item-cat-${id}`} error={errors.category}>
        <Select id={`item-cat-${id}`} name="category" className="w-full" defaultValue={initial?.category ?? 'kitchen'} options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: INVENTORY_CATEGORY_LABEL[c] }))} />
      </Field>
      <Field label="Expected quantity" htmlFor={`item-qty-${id}`} error={errors.expected}>
        <Input id={`item-qty-${id}`} name="expected" type="number" min={1} defaultValue={initial?.expected ?? 1} required />
      </Field>
      <Field label="Replacement cost" htmlFor={`item-cost-${id}`} error={errors.replacementCost}>
        <Input id={`item-cost-${id}`} name="cost" type="number" min={0} step={1000} defaultValue={initial?.replacementCost ?? 0} required />
      </Field>
      <Field label="Condition note" htmlFor={`item-cond-${id}`} error={errors.condition} className="sm:col-span-2">
        <Input id={`item-cond-${id}`} name="condition" defaultValue={initial?.condition} placeholder="New in March, one chipped rim" />
      </Field>
      <Field label="Photo" htmlFor={`item-photo-${id}`} className="sm:col-span-2">
        <PhotoField id={`item-photo-${id}`} value={photo} onChange={(names) => setPhoto(names.slice(-1))} />
      </Field>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" variant="accent" loading={saving}>
          {initial ? 'Save item' : 'Add item'}
        </Button>
        <Button variant="soft" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** A unit's inventory list and the checks counted against it, on the unit page. */
export function UnitInventoryCards({ unitId }: { unitId: string }) {
  const { villaOps } = useServices()
  const toast = useToast()
  const data = useResource(`villaOps.unit:${unitId}`, () => villaOps.unitInventory(unitId), { keepPrevious: false })
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [source, setSource] = useState('')
  const [copying, setCopying] = useState(false)

  if (data.status === 'error' && !data.data) return <ErrorState error={data.error} onRetry={data.reload} />
  if (!data.data) return <CardSkeleton lines={4} />
  const d = data.data
  const current = d.items.find((i) => i.id === editing) ?? null
  const total = d.items.reduce((s, i) => s + i.expected * i.replacementCost, 0)

  async function copy() {
    if (!source) return
    setCopying(true)
    try {
      const list = await villaOps.copyUnitItems(source, unitId)
      toast({ title: `Copied the list to ${d.unit.code}`, description: `${list.length} items now` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: 'Could not copy the list', description: error instanceof Error ? error.message : undefined })
    } finally {
      setCopying(false)
    }
  }

  async function remove(item: UnitItem) {
    try {
      await villaOps.removeUnitItem(item.id)
      toast({ title: `Removed ${item.name}` })
      data.reload()
    } catch (error) {
      toast({ tone: 'danger', title: `Could not remove ${item.name}`, description: error instanceof Error ? error.message : undefined })
    }
  }

  return (
    <>
      <Card aria-labelledby="inventory-title">
        <CardHeader
          id="inventory-title"
          title="Inventory"
          action={
            d.canEdit && (
              <Button size="sm" variant="solid" aria-pressed={editing === 'new'} onClick={() => setEditing(editing === 'new' ? null : 'new')}>
                <Plus aria-hidden className="size-3.5" /> Item
              </Button>
            )
          }
        />
        {(editing === 'new' || current) && (
          <ItemForm
            key={editing ?? ''}
            unitId={unitId}
            initial={current}
            onDone={(name) => {
              toast({ title: current ? `Saved ${name}` : `Added ${name}` })
              setEditing(null)
              data.reload()
            }}
            onCancel={() => setEditing(null)}
          />
        )}
        {d.items.length === 0 ? (
          <p className="text-sm text-muted">No inventory list yet. Add the items or copy the list of a unit like this one.</p>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">
              {d.items.length} items, {money(total)} to replace in full. Housekeeping counts them before each arrival and after each departure.
            </p>
            <ul className="divide-y divide-line">
              {d.items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {i.name} <span className="text-muted tabular">× {i.expected}</span>
                    </p>
                    <p className="truncate text-xs text-muted">
                      {INVENTORY_CATEGORY_LABEL[i.category]} · {money(i.replacementCost)} each
                      {i.condition && ` · ${i.condition}`}
                      {i.photo && ` · photo ${i.photo}`}
                    </p>
                  </div>
                  {d.canEdit && (
                    <div className="flex shrink-0 gap-1">
                      <Button size="icon-sm" variant="ghost" aria-label={`Edit ${i.name}`} aria-pressed={editing === i.id} onClick={() => setEditing(editing === i.id ? null : i.id)}>
                        <Pencil aria-hidden className="size-4" />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove ${i.name}`} onClick={() => void remove(i)}>
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {d.canEdit && d.copyFrom.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <Select aria-label="Copy the list of" value={source} className="min-w-0 flex-1" options={[{ value: '', label: 'Copy the list of…' }, ...d.copyFrom.map((u) => ({ value: u.id, label: `${u.code}${u.sameType ? ', same room type' : ''}` }))]} onChange={(e) => setSource(e.target.value)} />
            <Button size="sm" variant="soft" disabled={!source} loading={copying} onClick={() => void copy()}>
              <Copy aria-hidden className="size-3.5" /> Copy
            </Button>
          </div>
        )}
      </Card>
      <Card aria-labelledby="checks-title">
        <CardHeader id="checks-title" title="Inventory checks" />
        {d.checks.length === 0 ? (
          <p className="text-sm text-muted">No check counted on this unit yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {d.checks.map((c) => {
              const off = linesOff(c)
              return (
                <li key={c.id}>
                  <Link to={`/housekeeping/checks/${c.id}`} className="flex items-center gap-3 py-2.5 hover:underline">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {CHECK_KIND_LABEL[c.kind]} <span className="font-mono text-xs text-muted">{c.number}</span>
                      </p>
                      <p className="truncate text-xs text-muted">
                        {shortDay(c.on)} · {c.bookingCode} · {c.by}
                      </p>
                    </div>
                    <Tag tone={off ? 'danger' : 'success'}>{off ? `${off} off` : 'All in order'}</Tag>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </>
  )
}
