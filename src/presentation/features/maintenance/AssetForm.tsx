import { useState, type FormEvent } from 'react'
import { ASSET_STATUS_LABEL, ASSET_STATUSES, MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, type Asset, type AssetInput, type AssetStatus, type MaintenanceCategory } from '@/domain/maintenance'
import type { Catalog, Scope } from '@/domain/property'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field, Textarea } from '../../ui/Form'
import { ScopePicker } from '../shared/ScopePicker'

interface AssetFormProps {
  initial?: Asset
  catalog: Catalog
  save: (input: AssetInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** Register equipment in a unit or shared by a villa, with its purchase and warranty. */
export function AssetForm({ initial, catalog, save, onDone, onCancel }: AssetFormProps) {
  const [scope, setScope] = useState<Scope>(() => {
    const villa = catalog.villas.find((v) => v.id === initial?.villaId)
    return { locationId: villa?.locationId, villaId: villa?.id, unitId: initial?.unitId ?? undefined }
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const text = (k: string) => String(f.get(k) ?? '').trim()
    setSaving(true)
    setErrors({})
    try {
      await save({
        code: text('code').toUpperCase(),
        name: text('name'),
        category: f.get('category') as MaintenanceCategory,
        villaId: scope.villaId ?? '',
        unitId: scope.unitId ?? null,
        brand: text('brand'),
        model: text('model'),
        serial: text('serial'),
        purchasedOn: text('purchasedOn') || null,
        purchaseCost: Number(f.get('purchaseCost')) || 0,
        warrantyUntil: text('warrantyUntil') || null,
        status: f.get('status') as AssetStatus,
        notes: text('notes'),
      })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.code}` : 'Register an asset'} className="animate-rise">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.code}` : 'Register an asset'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Code" htmlFor="as-code" error={errors.code}>
            <Input id="as-code" name="code" defaultValue={initial?.code} placeholder="TR-03-AC" className="font-mono uppercase" />
          </Field>
          <Field label="Name" htmlFor="as-name" error={errors.name}>
            <Input id="as-name" name="name" defaultValue={initial?.name} placeholder="Split AC TR-03" />
          </Field>
          <Field label="Category" htmlFor="as-cat" error={errors.category}>
            <Select id="as-cat" name="category" className="w-full" defaultValue={initial?.category ?? 'ac'} options={MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))} />
          </Field>
          <Field label="Location, villa, unit" error={errors.villaId} hint="Leave the unit empty for shared equipment" className="sm:col-span-2 xl:col-span-3">
            <ScopePicker catalog={catalog} value={scope} onChange={setScope} className="grid grid-cols-1 gap-2 sm:grid-cols-3" />
          </Field>
          <Field label="Brand" htmlFor="as-brand">
            <Input id="as-brand" name="brand" defaultValue={initial?.brand} />
          </Field>
          <Field label="Model" htmlFor="as-model">
            <Input id="as-model" name="model" defaultValue={initial?.model} />
          </Field>
          <Field label="Serial number" htmlFor="as-serial">
            <Input id="as-serial" name="serial" defaultValue={initial?.serial} className="font-mono" />
          </Field>
          <Field label="Bought on" htmlFor="as-bought" error={errors.purchasedOn}>
            <Input id="as-bought" name="purchasedOn" type="date" defaultValue={initial?.purchasedOn ?? ''} />
          </Field>
          <Field label="Purchase cost, Rp" htmlFor="as-cost" error={errors.purchaseCost}>
            <Input id="as-cost" name="purchaseCost" type="number" min={0} step={1000} defaultValue={initial?.purchaseCost ?? 0} className="tabular" />
          </Field>
          <Field label="Warranty until" htmlFor="as-warranty" error={errors.warrantyUntil}>
            <Input id="as-warranty" name="warrantyUntil" type="date" defaultValue={initial?.warrantyUntil ?? ''} />
          </Field>
          <Field label="Status" htmlFor="as-status">
            <Select id="as-status" name="status" className="w-full" defaultValue={initial?.status ?? 'in_service'} options={ASSET_STATUSES.map((s) => ({ value: s, label: ASSET_STATUS_LABEL[s] }))} />
          </Field>
          <Field label="Notes" htmlFor="as-notes" className="sm:col-span-2">
            <Textarea id="as-notes" name="notes" rows={2} defaultValue={initial?.notes} />
          </Field>
        </div>
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save asset' : 'Register asset'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
