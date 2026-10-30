import { useState, type FormEvent } from 'react'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_CATEGORY_LABEL, type MaintenanceCategory, type Vendor, type VendorInput } from '@/domain/maintenance'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { Input, Select } from '../../ui/Field'
import { fieldErrors } from '../../ui/fieldErrors'
import { Field } from '../../ui/Form'
import { Switch } from '../../ui/Switch'

interface VendorFormProps {
  initial?: Vendor
  save: (input: VendorInput) => Promise<unknown>
  onDone: () => void
  onCancel: () => void
}

/** A contractor the villas call: trade, contact and the agreed rate. */
export function VendorForm({ initial, save, onDone, onCancel }: VendorFormProps) {
  const [active, setActive] = useState(initial?.active ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const text = (k: string) => String(f.get(k) ?? '').trim()
    setSaving(true)
    setErrors({})
    try {
      await save({ name: text('name'), trade: f.get('trade') as MaintenanceCategory, contact: text('contact'), phone: text('phone'), email: text('email'), rateNote: text('rateNote'), active })
      onDone()
    } catch (error) {
      setErrors(fieldErrors(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="div" aria-label={initial ? `Edit ${initial.name}` : 'Add a vendor'} className="animate-rise">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <p className="text-lg font-semibold tracking-tight">{initial ? `Edit ${initial.name}` : 'Add a vendor'}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="Name" htmlFor="vn-name" error={errors.name}>
            <Input id="vn-name" name="name" defaultValue={initial?.name} placeholder="Bali Pool Care" />
          </Field>
          <Field label="Trade" htmlFor="vn-trade" error={errors.trade}>
            <Select id="vn-trade" name="trade" className="w-full" defaultValue={initial?.trade ?? 'other'} options={MAINTENANCE_CATEGORIES.map((c) => ({ value: c, label: MAINTENANCE_CATEGORY_LABEL[c] }))} />
          </Field>
          <Field label="Contact person" htmlFor="vn-contact">
            <Input id="vn-contact" name="contact" defaultValue={initial?.contact} />
          </Field>
          <Field label="Phone" htmlFor="vn-phone" error={errors.phone}>
            <Input id="vn-phone" name="phone" defaultValue={initial?.phone} placeholder="+62 …" />
          </Field>
          <Field label="Email" htmlFor="vn-email" error={errors.email}>
            <Input id="vn-email" name="email" type="email" defaultValue={initial?.email} />
          </Field>
          <Field label="Rate" htmlFor="vn-rate">
            <Input id="vn-rate" name="rateNote" defaultValue={initial?.rateNote} placeholder="Rp 350.000 per visit" />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Switch label="Vendor active" checked={active} onChange={setActive} />
          <span className="text-sm text-muted">{active ? 'Shown when assigning jobs' : 'Hidden from new jobs'}</span>
        </div>
        {errors.form && <p role="alert" className="text-xs font-medium text-danger">{errors.form}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="accent" loading={saving}>
            {initial ? 'Save vendor' : 'Add vendor'}
          </Button>
          <Button variant="soft" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  )
}
