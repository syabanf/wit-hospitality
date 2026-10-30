import { useState, type FormEvent } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { NewWorkOrder } from '@/application/ports'
import type { AssetView, VendorView } from '@/application/views'
import type { Employee } from '@/domain/hr'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, PRIORITY_LABEL, WORK_ORDER_PRIORITIES, workOrderCost, type MaintenanceCategory, type Part, type WorkOrder, type WorkOrderPriority } from '@/domain/maintenance'
import type { Catalog, Scope } from '@/domain/property'
import { addDays } from '@/lib/dates'
import { money } from '@/lib/format'
import { Button } from '../../ui/Button'
import { Card, CardHeader } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { ScopePicker } from '../shared/ScopePicker'
import { PhotoField } from './PhotoField'

export interface WorkOrderOptions {
  catalog: Catalog
  assets: readonly AssetView[]
  vendors: readonly VendorView[]
  employees: readonly Employee[]
  today: string
}

interface WorkOrderFormProps {
  initial?: WorkOrder
  /** Prefill for a new job, from the unit page or an inspection. */
  preset?: Partial<NewWorkOrder>
  options: WorkOrderOptions
  save: (input: NewWorkOrder) => Promise<unknown>
  onDone: (result: unknown) => void
  onCancel: () => void
}

const num = (v: string) => (v === '' ? 0 : Number(v))

/** Report or edit a job: where, what, who, when, parts and costs, photos, and the optional unit block. */
export function WorkOrderForm({ initial, preset, options: o, save, onDone, onCancel }: WorkOrderFormProps) {
  const start = initial ?? preset
  const [scope, setScope] = useState<Scope>(() => {
    const villa = o.catalog.villas.find((v) => v.id === start?.villaId)
    return { locationId: villa?.locationId, villaId: villa?.id, unitId: start?.unitId ?? undefined }
  })
  const [assetId, setAssetId] = useState(start?.assetId ?? '')
  const [category, setCategory] = useState<MaintenanceCategory>(start?.category ?? 'other')
  const [priority, setPriority] = useState<WorkOrderPriority>(start?.priority ?? 'normal')
  const [title, setTitle] = useState(start?.title ?? '')
  const [description, setDescription] = useState(start?.description ?? '')
  const [assigneeId, setAssigneeId] = useState(start?.assigneeId ?? '')
  const [vendorId, setVendorId] = useState(start?.vendorId ?? '')
  const [scheduledOn, setScheduledOn] = useState(start?.scheduledOn ?? '')
  const [parts, setParts] = useState<Part[]>(start?.parts ? start.parts.map((p) => ({ ...p })) : [])
  const [labour, setLabour] = useState(String(start?.labourCost ?? 0))
  const [vendorCost, setVendorCost] = useState(String(start?.vendorCost ?? 0))
  const [before, setBefore] = useState<string[]>([...(start?.beforePhotos ?? [])])
  const [after, setAfter] = useState<string[]>([...(start?.afterPhotos ?? [])])
  const [block, setBlock] = useState(false)
  const [blockFrom, setBlockFrom] = useState(o.today)
  const [blockTo, setBlockTo] = useState(addDays(o.today, 2))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const assets = o.assets.filter((a) => (scope.unitId ? a.unitId === scope.unitId || (a.unitId === null && a.villaId === scope.villaId) : !scope.villaId || a.villaId === scope.villaId))
  const technicians = [...o.employees].sort((a, b) => Number(b.department === 'maintenance') - Number(a.department === 'maintenance') || a.name.localeCompare(b.name))
  const total = workOrderCost({ parts, labourCost: num(labour), vendorCost: num(vendorCost) })

  function pickAsset(id: string) {
    setAssetId(id)
    const asset = o.assets.find((a) => a.id === id)
    if (!asset) return
    setCategory(asset.category)
    const villa = o.catalog.villa(asset.villaId)
    setScope({ locationId: villa.locationId, villaId: villa.id, unitId: asset.unitId ?? scope.unitId })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      const result = await save({
        villaId: scope.villaId ?? '',
        unitId: scope.unitId ?? null,
        assetId: assetId || null,
        category,
        priority,
        title,
        description,
        assigneeId: assigneeId || null,
        vendorId: vendorId || null,
        scheduledOn: scheduledOn || null,
        parts,
        labourCost: num(labour),
        vendorCost: num(vendorCost),
        beforePhotos: before,
        afterPhotos: after,
        ...(block && !initial ? { blockFrom, blockTo } : {}),
        ...(preset?.source ? { source: preset.source } : {}),
      })
      onDone(result)
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <Card aria-labelledby="wo-what">
          <CardHeader id="wo-what" title="The job" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="What needs fixing" htmlFor="wo-title" error={errors.title} className="sm:col-span-2">
              <Input id="wo-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="No hot water in TR-02" />
            </Field>
            <Field label="Location, villa, unit" error={errors.villaId ?? errors.unitId} hint="Leave the unit empty for shared equipment" className="sm:col-span-2">
              <ScopePicker catalog={o.catalog} value={scope} onChange={(sc) => setScope(sc)} className="grid grid-cols-1 gap-2 sm:grid-cols-3" />
            </Field>
            <Field label="Asset" htmlFor="wo-asset">
              <Select id="wo-asset" className="w-full" value={assetId} options={[{ value: '', label: 'No asset' }, ...assets.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]} onChange={(e) => pickAsset(e.target.value)} />
            </Field>
            <Field label="Category" htmlFor="wo-cat" error={errors.category}>
              <Select id="wo-cat" className="w-full" value={category} options={MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))} onChange={(e) => setCategory(e.target.value as MaintenanceCategory)} />
            </Field>
            <Field label="Priority" htmlFor="wo-prio" error={errors.priority}>
              <Select id="wo-prio" className="w-full" value={priority} options={WORK_ORDER_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} onChange={(e) => setPriority(e.target.value as WorkOrderPriority)} />
            </Field>
            <Field label="Scheduled for" htmlFor="wo-date" error={errors.scheduledOn} hint="A date puts the job in Scheduled">
              <Input id="wo-date" type="date" value={scheduledOn} onChange={(e) => setScheduledOn(e.target.value)} />
            </Field>
            <Field label="Description" htmlFor="wo-desc" className="sm:col-span-2">
              <Textarea id="wo-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What the guest or staff saw, when it started" rows={3} />
            </Field>
          </div>
        </Card>
        <Card aria-labelledby="wo-who">
          <CardHeader id="wo-who" title="Who does it" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Technician" htmlFor="wo-tech">
              <Select id="wo-tech" className="w-full" value={assigneeId} options={[{ value: '', label: 'Nobody yet' }, ...technicians.map((e) => ({ value: e.id, label: `${e.name} · ${e.position}` }))]} onChange={(e) => setAssigneeId(e.target.value)} />
            </Field>
            <Field label="Vendor" htmlFor="wo-vendor">
              <Select id="wo-vendor" className="w-full" value={vendorId} options={[{ value: '', label: 'In-house' }, ...o.vendors.filter((v) => v.active || v.id === vendorId).map((v) => ({ value: v.id, label: `${v.name} · ${MAINTENANCE_CATEGORY_LABEL[v.trade]}` }))]} onChange={(e) => setVendorId(e.target.value)} />
            </Field>
          </div>
        </Card>
        <Card aria-labelledby="wo-parts">
          <CardHeader
            id="wo-parts"
            title="Parts"
            action={
              <Button size="sm" variant="soft" onClick={() => setParts([...parts, { name: '', qty: 1, unitCost: 0 }])}>
                <Plus aria-hidden className="size-3.5" /> Part
              </Button>
            }
          />
          {parts.length === 0 && <p className="text-sm text-muted">No parts yet.</p>}
          <ul className="space-y-3">
            {parts.map((p, i) => (
              <li key={i} className="grid grid-cols-[minmax(0,1fr)_4.5rem_7rem_auto] items-start gap-2">
                <Field label={i === 0 ? 'Part' : ''} htmlFor={`part-${i}`} error={errors[`parts.${i}.name`]}>
                  <Input id={`part-${i}`} value={p.name} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Thermostat" />
                </Field>
                <Field label={i === 0 ? 'Qty' : ''} htmlFor={`qty-${i}`} error={errors[`parts.${i}.qty`]}>
                  <Input id={`qty-${i}`} type="number" min={1} value={p.qty} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, qty: num(e.target.value) } : x)))} className="px-3 tabular" />
                </Field>
                <Field label={i === 0 ? 'Unit cost' : ''} htmlFor={`cost-${i}`} error={errors[`parts.${i}.unitCost`]}>
                  <Input id={`cost-${i}`} type="number" min={0} step={1000} value={p.unitCost} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, unitCost: num(e.target.value) } : x)))} className="px-3 tabular" />
                </Field>
                <Button size="icon" variant="ghost" aria-label={`Remove ${p.name || 'part'}`} className={i === 0 ? 'mt-6' : ''} onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Labour, Rp" htmlFor="wo-labour" error={errors.labourCost}>
              <Input id="wo-labour" type="number" min={0} step={1000} value={labour} onChange={(e) => setLabour(e.target.value)} className="tabular" />
            </Field>
            <Field label="Vendor invoice, Rp" htmlFor="wo-vcost" error={errors.vendorCost}>
              <Input id="wo-vcost" type="number" min={0} step={1000} value={vendorCost} onChange={(e) => setVendorCost(e.target.value)} className="tabular" />
            </Field>
          </div>
        </Card>
        <Card aria-labelledby="wo-photos">
          <CardHeader id="wo-photos" title="Photos" />
          <div className="space-y-4">
            <Field label="Before" htmlFor="wo-before">
              <PhotoField id="wo-before" value={before} onChange={setBefore} />
            </Field>
            <Field label="After" htmlFor="wo-after">
              <PhotoField id="wo-after" value={after} onChange={setAfter} />
            </Field>
          </div>
        </Card>
      </div>
      <div className="space-y-4">
        {!initial && scope.unitId && (
          <Card aria-labelledby="wo-block">
            <CardHeader id="wo-block" title="Block the unit" />
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
              <span>Stop selling the unit while the job is open. Guests already booked on those nights refuse the block.</span>
            </label>
            {block && (
              <div className="mt-4 grid grid-cols-2 gap-3 animate-rise">
                <Field label="From" htmlFor="wo-bfrom">
                  <Input id="wo-bfrom" type="date" value={blockFrom} onChange={(e) => setBlockFrom(e.target.value)} className="px-3" />
                </Field>
                <Field label="Until (check-out)" htmlFor="wo-bto" error={errors.to}>
                  <Input id="wo-bto" type="date" value={blockTo} min={blockFrom} onChange={(e) => setBlockTo(e.target.value)} className="px-3" />
                </Field>
              </div>
            )}
          </Card>
        )}
        <Card aria-labelledby="wo-sum">
          <CardHeader id="wo-sum" title="Cost" />
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Parts</dt>
              <dd className="tabular">{money(parts.reduce((s, p) => s + p.qty * p.unitCost, 0))}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Labour</dt>
              <dd className="tabular">{money(num(labour))}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Vendor</dt>
              <dd className="tabular">{money(num(vendorCost))}</dd>
            </div>
            <div className="flex justify-between border-t border-line-strong pt-2 font-semibold">
              <dt>Total</dt>
              <dd className="tabular">{money(total)}</dd>
            </div>
          </dl>
          {errors.form && (
            <p role="alert" className="mt-3 text-xs font-medium text-danger">
              {errors.form}
            </p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <Button type="submit" variant="accent" loading={saving}>
              {initial ? 'Save changes' : 'Open work order'}
            </Button>
            <Button variant="soft" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </Card>
      </div>
    </form>
  )
}
