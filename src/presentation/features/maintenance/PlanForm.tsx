import { useState, type FormEvent } from 'react'
import type { AssetView, PlanView, VendorView } from '@/application/views'
import type { Employee } from '@/domain/hr'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, type IntervalUnit, type MaintenanceCategory, type PlanInput } from '@/domain/maintenance'
import type { Catalog, Scope } from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { Switch } from '../../ui/Switch'
import { ScopePicker } from '../shared/ScopePicker'

interface PlanFormProps {
  initial?: PlanView
  catalog: Catalog
  assets: readonly AssetView[]
  vendors: readonly VendorView[]
  employees: readonly Employee[]
  today: string
  save: (input: PlanInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** A recurring job: where, how often, the checklist and who does it. */
export function PlanForm({ initial, catalog, assets, vendors, employees, today, save, onDone, onCancel }: PlanFormProps) {
  const [scope, setScope] = useState<Scope>(() => {
    const villa = catalog.villas.find((v) => v.id === initial?.villaId)
    return { locationId: villa?.locationId, villaId: villa?.id, unitId: initial?.unitId ?? undefined }
  })
  const [unit, setUnit] = useState<IntervalUnit>(initial?.unit ?? 'months')
  const [active, setActive] = useState(initial?.active ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setSaving(true)
    setErrors({})
    try {
      await save({
        title: String(f.get('title') ?? ''),
        category: f.get('category') as MaintenanceCategory,
        villaId: scope.villaId ?? '',
        unitId: scope.unitId ?? null,
        assetId: String(f.get('asset') ?? '') || null,
        every: Number(f.get('every')),
        unit,
        nextDue: String(f.get('nextDue') ?? ''),
        checklist: String(f.get('checklist') ?? '')
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        assigneeId: String(f.get('assignee') ?? '') || null,
        vendorId: String(f.get('vendor') ?? '') || null,
        estimatedCost: Number(f.get('cost')) || 0,
        active,
      })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.title}` : 'New preventive plan'} className="animate-rise">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.title}` : 'New preventive plan'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Job" htmlFor="pl-title" error={errors.title} className="sm:col-span-2">
            <Input id="pl-title" name="title" defaultValue={initial?.title} placeholder="AC service, Villa Tirta" />
          </Field>
          <Field label="Category" htmlFor="pl-cat" error={errors.category}>
            <Select id="pl-cat" name="category" className="w-full" defaultValue={initial?.category ?? 'ac'} options={MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))} />
          </Field>
          <Field label="Location, villa, unit" error={errors.villaId} hint="Leave the unit empty for the whole villa" className="sm:col-span-2 xl:col-span-3">
            <ScopePicker catalog={catalog} value={scope} onChange={setScope} className="grid grid-cols-1 gap-2 sm:grid-cols-3" />
          </Field>
          <Field label="Asset" htmlFor="pl-asset">
            <Select id="pl-asset" name="asset" className="w-full" defaultValue={initial?.assetId ?? ''} options={[{ value: '', label: 'No asset' }, ...assets.filter((a) => !scope.villaId || a.villaId === scope.villaId).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }))]} />
          </Field>
          <Field label="Every" htmlFor="pl-every" error={errors.every}>
            <div className="flex gap-2">
              <Input id="pl-every" name="every" type="number" min={1} defaultValue={initial?.every ?? 1} className="w-24 px-3 tabular" />
              <Select aria-label="Interval unit" className="flex-1" value={unit} options={[{ value: 'days', label: 'Days' }, { value: 'months', label: 'Months' }]} onChange={(e) => setUnit(e.target.value as IntervalUnit)} />
            </div>
          </Field>
          <Field label="Next due" htmlFor="pl-due" error={errors.nextDue}>
            <Input id="pl-due" name="nextDue" type="date" defaultValue={initial?.nextDue ?? today} />
          </Field>
          <Field label="Technician" htmlFor="pl-tech">
            <Select id="pl-tech" name="assignee" className="w-full" defaultValue={initial?.assigneeId ?? ''} options={[{ value: '', label: 'Nobody' }, ...employees.map((e) => ({ value: e.id, label: e.name }))]} />
          </Field>
          <Field label="Vendor" htmlFor="pl-vendor">
            <Select id="pl-vendor" name="vendor" className="w-full" defaultValue={initial?.vendorId ?? ''} options={[{ value: '', label: 'In-house' }, ...vendors.map((v) => ({ value: v.id, label: v.name }))]} />
          </Field>
          <Field label="Estimated cost, Rp" htmlFor="pl-cost" error={errors.estimatedCost}>
            <Input id="pl-cost" name="cost" type="number" min={0} step={1000} defaultValue={initial?.estimatedCost ?? 0} className="tabular" />
          </Field>
          <Field label="Checklist, one line each" htmlFor="pl-check" error={errors.checklist} className="sm:col-span-2 xl:col-span-3">
            <Textarea id="pl-check" name="checklist" rows={3} defaultValue={initial?.checklist.join('\n')} placeholder={'Clean filters\nCheck freon pressure'} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Switch label="Plan active" checked={active} onChange={setActive} />
          <span className="text-sm text-muted">{active ? 'Opens jobs when due' : 'Paused'}</span>
        </div>
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save plan' : 'Add plan'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
